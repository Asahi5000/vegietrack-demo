<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Auth-Token');
header('Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

// Load backend/.env if available
$envFile = __DIR__ . '/../backend/.env';
if (file_exists($envFile)) {
    $lines = file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    foreach ($lines as $line) {
        if (strpos(trim($line), '#') === 0 || !strpos($line, '=')) continue;
        list($name, $value) = explode('=', $line, 2);
        $name = trim($name);
        $value = trim($value);
        if (!getenv($name)) {
            putenv("$name=$value");
            $_ENV[$name] = $value;
        }
    }
}

$dbHost = getenv('DEMO_DB_HOST') ?: 'localhost';
$dbName = getenv('DEMO_DB_NAME') ?: 'vegietrack_demo';
$dbUser = getenv('DEMO_DB_USER') ?: '';
$dbPassword = getenv('DEMO_DB_PASSWORD') ?: '';
$dbPort = getenv('DEMO_DB_PORT') ?: '3306';
$jwtSecret = getenv('DEMO_JWT_SECRET') ?: '';
$demoLoginUsername = getenv('DEMO_LOGIN_USERNAME') ?: 'demo';

if (!$dbUser || !$jwtSecret) {
    respond(['message' => 'Demo database and signing key must be configured on the server', 'code' => 'ECONFIG'], 500);
}

$isPg = (strpos($dbHost, 'supabase') !== false || $dbPort === '6543' || $dbPort === '5432');

try {
    if ($isPg && in_array('pgsql', PDO::getAvailableDrivers(), true)) {
        $dsn = "pgsql:host=$dbHost;port=$dbPort;dbname=$dbName;sslmode=require";
        $pdo = new PDO($dsn, $dbUser, $dbPassword, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
    } else {
        $pdo = new PDO("mysql:host=$dbHost;port=$dbPort;dbname=$dbName;charset=utf8mb4", $dbUser, $dbPassword, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
    }
} catch (PDOException $error) {
    respond(['message' => 'Database connection failed: ' . $error->getMessage()], 500);
}

$method = $_SERVER['REQUEST_METHOD'];
$path = trim(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH), '/');
$apiPosition = array_search('api', explode('/', $path), true);
$route = $apiPosition === false ? '' : implode('/', array_slice(explode('/', $path), $apiPosition + 1));
$parts = $route === '' ? [] : explode('/', $route);
$body = json_decode(file_get_contents('php://input'), true) ?: [];

// Set by ensureTransactionItemCostSchema(): true when transaction_items.cost_price
// exists. Queries fall back to products.cost when the column is unavailable so a
// failed migration can never break sales, restocking, or reports.
$transactionItemCostColumn = false;

function hasColumn(PDO $pdo, string $table, string $column): bool {
    $driver = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME);
    if ($driver === 'pgsql') {
        $stmt = $pdo->prepare("SELECT column_name FROM information_schema.columns WHERE table_name = ? AND column_name = ?");
        $stmt->execute([$table, $column]);
        return (bool)$stmt->fetch();
    } else {
        $stmt = $pdo->prepare("SHOW COLUMNS FROM `$table` LIKE ?");
        $stmt->execute([$column]);
        return (bool)$stmt->fetch();
    }
}
function hasTable(PDO $pdo, string $table): bool {
    $driver = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME);
    try {
        if ($driver === 'pgsql') {
            $stmt = $pdo->prepare("SELECT 1 FROM information_schema.tables WHERE table_name = ? AND table_schema = current_schema()");
            $stmt->execute([$table]);
        } else {
            $stmt = $pdo->prepare("SHOW TABLES LIKE ?");
            $stmt->execute([$table]);
        }
        return (bool)$stmt->fetch();
    } catch (Throwable $t) {
        return false;
    }
}

function ensurePayrollSchema(PDO $pdo): void {
    try {
        if (!hasColumn($pdo, 'users', 'payroll')) {
            $pdo->exec('ALTER TABLE users ADD COLUMN payroll DECIMAL(10,2) NOT NULL DEFAULT 0');
        }
    } catch (Throwable $t) {}
}

function ensureTransactionItemCostSchema(PDO $pdo): bool {
    global $transactionItemCostColumn;
    if ($transactionItemCostColumn) return true;
    try {
        if (!hasColumn($pdo, 'transaction_items', 'cost_price')) {
            $pdo->exec('ALTER TABLE transaction_items ADD COLUMN cost_price DECIMAL(10,4) DEFAULT NULL');
        }
        $transactionItemCostColumn = hasColumn($pdo, 'transaction_items', 'cost_price');
    } catch (PDOException $error) {
        error_log('VegieTrack transaction item cost schema unavailable: ' . $error->getMessage());
        $transactionItemCostColumn = false;
    }
    return $transactionItemCostColumn;
}
/**
 * Self-applying migration for FIFO batch-level inventory tracking.
 * Creates the inventory_batches table, adds shelf_life_days to products
 * (where missing), and backfills existing stock as a single batch per product.
 */
function ensureInventoryBatchSchema(PDO $pdo): void {
    // 1. Add shelf_life_days column to products (default 5 days)
    if (!hasColumn($pdo, 'products', 'shelf_life_days')) {
        $pdo->exec("ALTER TABLE products ADD COLUMN shelf_life_days INT NOT NULL DEFAULT 5");
    }
    // 2. Create inventory_batches table if it doesn't exist
    $pdo->exec("CREATE TABLE IF NOT EXISTS inventory_batches (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        transaction_id INT DEFAULT NULL,
        purchase_date DATE NOT NULL DEFAULT (CURRENT_DATE),
        quantity DECIMAL(10,4) NOT NULL DEFAULT 0,
        original_quantity DECIMAL(10,4) NOT NULL DEFAULT 0,
        cost_per_base DECIMAL(10,4) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
        FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE SET NULL
    )");
    // 3. Backfill existing stock as a single batch per product
    $rows = $pdo->query("SELECT id, stock_quantity, cost FROM products WHERE stock_quantity > 0")->fetchAll();
    if ($rows) {
        $insertBatch = $pdo->prepare("INSERT INTO inventory_batches (product_id, transaction_id, purchase_date, quantity, original_quantity, cost_per_base) VALUES (?, NULL, CURRENT_DATE, ?, ?, ?)");
        foreach ($rows as $row) {
            $qty = (float)$row['stock_quantity'];
            if ($qty > 0) {
                $insertBatch->execute([(int)$row['id'], $qty, $qty, (float)$row['cost']]);
            }
        }
    }
}
/**
 * Seed cost_price for rows written before the column existed.
 * The historical cost of a sale is rebuilt from the latest restock recorded on or
 * before that sale (its cost per base unit = line_total / base_quantity) and falls
 * back to the product's current cost when no restock history exists.
 */
function backfillTransactionItemCostPrice(PDO $pdo): void {
    $pdo->exec('DROP TEMPORARY TABLE IF EXISTS tmp_sale_cost');
    $pdo->exec("CREATE TEMPORARY TABLE tmp_sale_cost AS SELECT ti.id item_id, (SELECT ROUND(ri.line_total / ri.base_quantity, 4) FROM transaction_items ri JOIN transactions rt ON rt.id = ri.transaction_id WHERE rt.transaction_type = 'restock' AND ri.product_id = ti.product_id AND ri.base_quantity > 0 AND rt.created_at <= st.created_at ORDER BY rt.created_at DESC, ri.id DESC LIMIT 1) cost_per_base FROM transaction_items ti JOIN transactions st ON st.id = ti.transaction_id WHERE st.transaction_type = 'sale' AND ti.cost_price IS NULL");
    $pdo->exec('ALTER TABLE tmp_sale_cost ADD PRIMARY KEY (item_id)');
    $pdo->exec('UPDATE transaction_items ti JOIN tmp_sale_cost s ON s.item_id = ti.id LEFT JOIN products p ON p.id = ti.product_id SET ti.cost_price = COALESCE(s.cost_per_base, p.cost) WHERE ti.cost_price IS NULL');
    $pdo->exec('DROP TEMPORARY TABLE IF EXISTS tmp_sale_cost');
}
function payrollAmountForRole(string $role, $amount): float {
    if ($role !== 'manager' && $role !== 'cashier') {
        return 0;
    }
    return max(0, (float)$amount);
}
function respond($data, int $status = 200): void {
    http_response_code($status);
    echo json_encode($data);
    exit;
}
function tokenFor(array $user, string $secret): string {
    $payload = base64url(json_encode(['id' => $user['id'], 'demo_mode' => true, 'exp' => time() + 7200]));
    return $payload . '.' . base64url(hash_hmac('sha256', $payload, $secret, true));
}
function base64url(string $value): string {
    return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
}
function decodeBase64url(string $value): string {
    $value = strtr($value, '-_', '+/');
    $padding = strlen($value) % 4;
    if ($padding > 0) {
        $value .= str_repeat('=', 4 - $padding);
    }
    return base64_decode($value) ?: '';
}
function currentUser(PDO $pdo, string $secret): array {
    $token = $_SERVER['HTTP_X_AUTH_TOKEN'] ?? '';
    if (!$token) {
        $header = $_SERVER['HTTP_AUTHORIZATION'] ?? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
        if (preg_match('/Bearer\s+(.+)/i', $header, $match)) {
            $token = $match[1];
        }
    }
    if (!$token) respond(['message' => 'Authentication required'], 401);
    $chunks = explode('.', $token);
    if (count($chunks) !== 2 || !hash_equals(base64url(hash_hmac('sha256', $chunks[0], $secret, true)), $chunks[1])) {
        respond(['message' => 'Invalid authentication token'], 401);
    }
    $payload = json_decode(decodeBase64url($chunks[0]), true);
    if (!$payload || ($payload['exp'] ?? 0) < time() || ($payload['demo_mode'] ?? false) !== true) respond(['message' => 'Invalid or expired demo token'], 401);
    $query = $pdo->prepare('SELECT id, username, full_name, email, role, status FROM users WHERE id = ?');
    $query->execute([$payload['id']]);
    $user = $query->fetch();
    if (!$user || $user['status'] !== 'active') respond(['message' => 'Authentication failed'], 401);
    $user['demo_mode'] = true;
    return $user;
}
function blockDemoAdminWrites(array $user): void {
    if (($user['demo_mode'] ?? false) === true) {
        respond(['message' => 'This administrative action is disabled in the public demo.'], 403);
    }
}
function requireAdmin(array $user): void {
    if ($user['role'] !== 'admin') respond(['message' => 'Administrator access required'], 403);
}
// Voiding/deleting a transaction rewrites the sales history, so those actions are
// restricted to the owner (admin) and managers. Mirrors requireRole('admin','manager')
// in the Node API (backend/middleware/auth.js).
function requireManager(array $user): void {
    if (!in_array($user['role'], ['admin', 'manager'], true)) respond(['message' => 'Manager access required'], 403);
}
function inputValue(array $body, string $key, $default = null) {
    return array_key_exists($key, $body) ? $body[$key] : $default;
}
function lastInsertedId(PDO $pdo, string $table): string {
    if ($pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'pgsql') {
        $query = $pdo->prepare("SELECT currval(pg_get_serial_sequence(?, 'id'))");
        $query->execute([$table]);
        $id = $query->fetchColumn();
        if ($id === false || $id === null) {
            throw new PDOException("Unable to retrieve the inserted ID for $table");
        }
        return (string)$id;
    }
    return $pdo->lastInsertId();
}
/**
 * Unit conversion helpers for multi-unit inventory system.
 * All stock is stored in base_unit (e.g., kg or pcs).
 * Selling units (pack, sack, g, etc.) are converted to/from base_unit using multiplier_to_base.
 */
function getProductUnits(PDO $pdo, int $productId, bool $forPurchase = false, bool $forSale = false): array {
    $sql = 'SELECT id, unit, label, multiplier_to_base, is_default, is_purchase_unit, is_sales_unit, price FROM product_units WHERE product_id = ?';
    if ($forPurchase) $sql .= ' AND is_purchase_unit = 1';
    if ($forSale) $sql .= ' AND is_sales_unit = 1';
    $sql .= ' ORDER BY is_default DESC, multiplier_to_base ASC, unit ASC';
    $q = $pdo->prepare($sql);
    $q->execute([$productId]);
    return $q->fetchAll();
}
/**
 * Look up the conversion definition for one unit of a product.
 * Returns the product_units row, or null when the unit is not configured.
 * The product's own base_unit is always accepted at 1:1 so products created
 * before multi-unit support keep working without any product_units rows.
 */
function resolveProductUnit(PDO $pdo, int $productId, string $unit, string $baseUnit, bool $forPurchase = false, bool $forSale = false): ?array {
    $unit = trim($unit);
    if ($unit === '') return null;
    foreach (getProductUnits($pdo, $productId) as $candidate) {
        if (strcasecmp((string)$candidate['unit'], $unit) !== 0) continue;
        if ($forPurchase && (int)$candidate['is_purchase_unit'] !== 1) return null;
        if ($forSale && (int)$candidate['is_sales_unit'] !== 1) return null;
        return $candidate;
    }
    if (strcasecmp($unit, trim($baseUnit)) === 0) {
        return ['id' => null, 'unit' => $baseUnit, 'label' => $baseUnit, 'multiplier_to_base' => 1, 'is_default' => 1, 'is_purchase_unit' => 1, 'is_sales_unit' => 1, 'price' => null];
    }
    return null;
}
/**
 * Weight/volume units accept decimal quantities; countable units do not.
 */
function unitAllowsDecimals(string $unit): bool {
    return in_array(strtolower(trim($unit)), ['kg', 'g', 'gram', 'grams', 'kilogram', 'kilograms', 'ton', 'tonne', 'tonnes', 'liter', 'litre', 'liters', 'litres', 'l', 'ml'], true);
}
/**
 * Trim trailing zeros so messages read "3 kg" instead of "3.0000 kg".
 */
function formatQuantity(float $value): string {
    $text = rtrim(rtrim(number_format($value, 4, '.', ''), '0'), '.');
    return ($text === '' || $text === '-') ? '0' : $text;
}
/**
 * Human readable "label (unit)" used in validation messages.
 */
function unitDisplayName(array $unitRow): string {
    $unit = (string)($unitRow['unit'] ?? '');
    $label = trim((string)($unitRow['label'] ?? ''));
    return $label !== '' && strcasecmp($label, $unit) !== 0 ? $label : $unit;
}
/**
 * Preferred unit for a product, optionally restricted to units that may be purchased/sold.
 * Falls back to the product's base unit so products without any configured units still work.
 */
function getDefaultUnit(PDO $pdo, int $productId, bool $forPurchase = false, bool $forSale = false): array {
    $units = getProductUnits($pdo, $productId, $forPurchase, $forSale);
    foreach ($units as $candidate) {
        if ((int)$candidate['is_default'] === 1) return $candidate;
    }
    if ($units) return $units[0];
    $q = $pdo->prepare('SELECT base_unit FROM products WHERE id = ?');
    $q->execute([$productId]);
    $base = (string)($q->fetchColumn() ?: '');
    return ['id' => null, 'unit' => $base, 'label' => $base, 'multiplier_to_base' => 1, 'is_default' => 1, 'is_purchase_unit' => 1, 'is_sales_unit' => 1, 'price' => null];
}
/**
 * Convert a quantity from a selling unit to the base unit.
 * base_quantity = quantity * multiplier_to_base
 * Example: 5 packs * 0.5 (kg/pack) = 2.5 kg
 */
function convertToBase(PDO $pdo, int $productId, string $unit, float $quantity, bool $forPurchase = false, bool $forSale = false): ?float {
    $baseUnit = '';
    $q = $pdo->prepare('SELECT base_unit FROM products WHERE id = ?');
    $q->execute([$productId]);
    $baseUnit = (string)($q->fetchColumn() ?: '');
    $resolved = resolveProductUnit($pdo, $productId, $unit, $baseUnit, $forPurchase, $forSale);
    if ($resolved === null) return null;
    return round($quantity * (float)$resolved['multiplier_to_base'], 4);
}
/**
 * Convert a quantity from the base unit to a selling unit.
 * selling_quantity = base_quantity / multiplier_to_base
 * Example: 2.5 kg / 0.5 (kg/pack) = 5 packs
 */
function convertFromBase(PDO $pdo, int $productId, string $unit, float $baseQuantity, bool $forPurchase = false, bool $forSale = false): ?float {
    $q = $pdo->prepare('SELECT base_unit FROM products WHERE id = ?');
    $q->execute([$productId]);
    $baseUnit = (string)($q->fetchColumn() ?: '');
    $resolved = resolveProductUnit($pdo, $productId, $unit, $baseUnit, $forPurchase, $forSale);
    if ($resolved === null) return null;
    $rate = (float)$resolved['multiplier_to_base'];
    if ($rate == 0) return null;
    return round($baseQuantity / $rate, 4);
}
/**
 * Countable units (sacks, boxes, packs, pcs, trays...) must be whole numbers.
 * Weight/volume units accept decimals. Returns an error message when the
 * quantity does not fit the unit, or null when the quantity is acceptable.
 */
function quantityUnitError(string $unit, float $quantity): ?string {
    if (unitAllowsDecimals($unit)) return null;
    if (abs($quantity - round($quantity)) > 0.0001) {
        return 'Unit "' . $unit . '" must be a whole number. Received: ' . formatQuantity($quantity) . '.';
    }
    return null;
}
/**
 * Render the stock of a product as its base unit plus a friendly equivalent
 * breakdown using the product's configured larger units.
 * Example: 498 kg -> "9 sack + 48 kg"
 */
function stockBreakdown(PDO $pdo, int $productId, float $baseQuantity, string $baseUnit): string {
    $remaining = $baseQuantity;
    $parts = [];
    $units = getProductUnits($pdo, $productId);
    usort($units, fn($a, $b) => (float)$b['multiplier_to_base'] <=> (float)$a['multiplier_to_base']);
    foreach ($units as $unitRow) {
        $rate = (float)$unitRow['multiplier_to_base'];
        if ($rate <= 1) continue;
        $whole = floor(($remaining + 0.0000001) / $rate);
        if ($whole < 1) continue;
        $remaining = round($remaining - ($whole * $rate), 4);
        if ($remaining < 0.0001) $remaining = 0.0;
        $parts[] = formatQuantity($whole) . ' ' . unitDisplayName($unitRow);
    }
    if ($remaining > 0.0001 || !$parts) {
        $parts[] = formatQuantity($remaining) . ' ' . $baseUnit;
    }
    return implode(' + ', $parts);
}
/**
 * Replace every configured unit for a product using the payload sent by the
 * product form. Keeps the unit flags (purchase/sale) and optional unit price.
 */
function saveProductUnits(PDO $pdo, int $productId, array $units, bool $replaceExisting): void {
    if ($replaceExisting) {
        $pdo->prepare('DELETE FROM product_units WHERE product_id = ?')->execute([$productId]);
    }
    $insert = $pdo->prepare('INSERT INTO product_units (product_id, unit, label, multiplier_to_base, is_default, is_purchase_unit, is_sales_unit, price) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE label=VALUES(label), multiplier_to_base=VALUES(multiplier_to_base), is_default=VALUES(is_default), is_purchase_unit=VALUES(is_purchase_unit), is_sales_unit=VALUES(is_sales_unit), price=VALUES(price)');
    foreach ($units as $unitData) {
        if (!is_array($unitData)) continue;
        $unitName = trim((string)inputValue($unitData, 'unit', ''));
        $multiplier = (float)inputValue($unitData, 'multiplier_to_base', 0);
        if ($unitName === '' || $multiplier <= 0) continue;
        $label = trim((string)inputValue($unitData, 'label', ''));
        $priceValue = inputValue($unitData, 'price', null);
        $price = ($priceValue === null || $priceValue === '') ? null : (float)$priceValue;
        $insert->execute([
            $productId,
            $unitName,
            $label === '' ? null : $label,
            $multiplier,
            (int)(bool)inputValue($unitData, 'is_default', 0),
            (int)inputValue($unitData, 'is_purchase_unit', 1),
            (int)inputValue($unitData, 'is_sales_unit', 1),
            $price,
        ]);
    }
}
/**
 * Guarantee that the product's base unit is always selectable.
 * Existing products (created before multi-unit support) have no product_units
 * rows at all, so without this the selling unit dropdown would be empty.
 */
function ensureBaseUnitRow(PDO $pdo, int $productId, string $baseUnit): void {
    $baseUnit = trim($baseUnit);
    if ($baseUnit === '') return;
    $q = $pdo->prepare('SELECT COUNT(*) FROM product_units WHERE product_id = ? AND LOWER(unit) = LOWER(?)');
    $q->execute([$productId, $baseUnit]);
    if ((int)$q->fetchColumn() > 0) return;
    $q = $pdo->prepare('SELECT COUNT(*) FROM product_units WHERE product_id = ?');
    $q->execute([$productId]);
    $isFirst = (int)$q->fetchColumn() === 0;
    $insert = $pdo->prepare('INSERT INTO product_units (product_id, unit, label, multiplier_to_base, is_default, is_purchase_unit, is_sales_unit, price) VALUES (?, ?, ?, 1, ?, 0, 1, NULL)');
    $insert->execute([$productId, $baseUnit, $baseUnit, $isFirst ? 1 : 0]);
}
function deleteImageFile($imageUrl): void {
    if ($imageUrl === null || $imageUrl === '') return;
    $segments = explode('/', (string)$imageUrl);
    $filename = $segments[count($segments) - 1];
    if ($filename === '' || !preg_match('/^product_[0-9]+_[0-9a-f]{12}\\.(jpg|jpeg|png|webp)$/', $filename)) return;
    $path = __DIR__ . '/uploads/products/' . $filename;
    if (is_file($path)) unlink($path);
}
function rangeForPeriod(string $period, string $column): array {
    if ($period === 'weekly') {
        return ['groupExpr' => "DATE_FORMAT($column, '%x-W%v')", 'rangeCondition' => "$column >= DATE_SUB(CURDATE(), INTERVAL 8 WEEK)"];
    }
    if ($period === 'monthly') {
        return ['groupExpr' => "DATE_FORMAT($column, '%Y-%m')", 'rangeCondition' => "$column >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)"];
    }
    if ($period === 'annual') {
        return ['groupExpr' => "YEAR($column)", 'rangeCondition' => "$column >= DATE_SUB(CURDATE(), INTERVAL 5 YEAR)"];
    }
    return ['groupExpr' => "DATE($column)", 'rangeCondition' => "$column >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)"];
}
// Per-transaction profit for report/chart queries: (suggested retail price per base unit âˆ’
// cost per base unit) Ã— base units sold for every sale item.
// ti.unit_price / ti.conversion_rate is the suggested retail price per base unit charged on
// the sale and ti.cost_price is the product cost per base unit captured when the
// sale was recorded. Reading the stored cost (instead of products.cost) keeps past
// profit stable when a product is restocked or edited afterwards; databases that do
// not have the column yet fall back to the current products.cost.
// Restock transactions also store item lines (at purchase cost), so only 'sale'
// transactions are counted. Items whose product no longer exists contribute
// nothing (cost is NULL â†’ the row is skipped by SUM).
function profitJoinSql(): string {
    $costPerBase = $GLOBALS['transactionItemCostColumn'] ? 'COALESCE(ti.cost_price, p.cost)' : 'p.cost';
    return ' LEFT JOIN (SELECT ti.transaction_id, SUM(CASE WHEN ti.base_quantity > 0 THEN ti.base_quantity ELSE ti.quantity END'
        . ' * (ti.unit_price / COALESCE(NULLIF(ti.conversion_rate, 0), 1) - ' . $costPerBase . ')) profit'
        . ' FROM transaction_items ti LEFT JOIN products p ON ti.product_id=p.id'
        . " JOIN transactions ts ON ts.id=ti.transaction_id AND ts.transaction_type='sale'"
        . ' GROUP BY ti.transaction_id) pr ON pr.transaction_id=t.id';
}
function smtpCommand($socket, string $command, array $expectedCodes): void {
    if ($command !== '') {
        fwrite($socket, $command . "\r\n");
    }
    $response = '';
    while (($line = fgets($socket, 515)) !== false) {
        $response .= $line;
        if (strlen($line) < 4 || $line[3] === ' ') break;
    }
    $code = (int)substr($response, 0, 3);
    if (!in_array($code, $expectedCodes, true)) {
        throw new RuntimeException('Gmail SMTP request failed');
    }
}
function sendGmailReset(string $to, string $from, string $appPassword, string $resetUrl): void {
    $socket = fsockopen('ssl://smtp.gmail.com', 465, $errorNumber, $errorMessage, 15);
    if (!$socket) throw new RuntimeException('Unable to connect to Gmail SMTP');
    try {
        smtpCommand($socket, '', [220]);
        smtpCommand($socket, 'EHLO VegieTrack', [250]);
        smtpCommand($socket, 'AUTH LOGIN', [334]);
        smtpCommand($socket, base64_encode($from), [334]);
        smtpCommand($socket, base64_encode($appPassword), [235]);
        smtpCommand($socket, 'MAIL FROM:<' . $from . '>', [250]);
        smtpCommand($socket, 'RCPT TO:<' . $to . '>', [250, 251]);
        smtpCommand($socket, 'DATA', [354]);
        $message = "From: VegieTrack <{$from}>\r\n";
        $message .= "To: {$to}\r\n";
        $message .= "Subject: VegieTrack Password Reset\r\n";
        $message .= "MIME-Version: 1.0\r\n";
        $message .= "Content-Type: text/html; charset=UTF-8\r\n\r\n";
        $message .= '<p>We received a request to reset your VegieTrack password.</p>';
        $message .= '<p><a href="' . htmlspecialchars($resetUrl, ENT_QUOTES, 'UTF-8') . '">Reset your password</a></p>';
        $message .= "<p>This link expires in 1 hour.</p>\r\n.";
        smtpCommand($socket, $message, [250]);
        smtpCommand($socket, 'QUIT', [221]);
    } finally {
        fclose($socket);
    }
}

try {
    ensurePayrollSchema($pdo);
} catch (PDOException $error) {
    respond(['message' => 'Unable to prepare payroll storage'], 500);
}

// Self-applying migration: freeze the cost used for profit inside each sale line.
// When the column cannot be created the API keeps working and reports keep using
// products.cost (the previous behaviour).
try {
    ensureTransactionItemCostSchema($pdo);
} catch (PDOException $error) {
    // Reporting/selling continue without the stored cost column.
}

// Self-applying migration for FIFO batch-level inventory tracking.
// Creates inventory_batches, adds shelf_life_days, backfills existing stock.
try {
    ensureInventoryBatchSchema($pdo);
} catch (PDOException $error) {
    // If batch schema cannot be created, sales/restocks fall back to simple
    // stock_quantity updates — inventory still works, just not FIFO tracked.
}

if ($route === 'health') respond(['status' => 'ok', 'message' => 'VegieTrack API is running']);

if ($route === 'upload/product-image' && $method === 'POST') {
    currentUser($pdo, $jwtSecret);
    if (empty($_FILES['image'])) respond(['message' => 'No image file provided'], 400);
    $file = $_FILES['image'];
    $allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    $maxSize = 5 * 1024 * 1024; // 5 MB
    if ($file['error'] !== UPLOAD_ERR_OK) respond(['message' => 'File upload failed'], 400);
    if ($file['size'] > $maxSize) respond(['message' => 'Image must be smaller than 5 MB'], 400);
    $finfo = new finfo(FILEINFO_MIME_TYPE);
    $mimeType = $finfo->file($file['tmp_name']);
    if (!in_array($mimeType, $allowedTypes, true)) respond(['message' => 'Only JPEG, PNG, and WebP images are allowed'], 400);
    $extensions = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp'];
    $ext = $extensions[$mimeType];
    $uploadDir = __DIR__ . '/uploads/products';
    if (!is_dir($uploadDir)) mkdir($uploadDir, 0755, true);
    $filename = 'product_' . time() . '_' . bin2hex(random_bytes(6)) . '.' . $ext;
    $destination = $uploadDir . '/' . $filename;
    if (!move_uploaded_file($file['tmp_name'], $destination)) respond(['message' => 'Failed to save image'], 500);
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host = $_SERVER['HTTP_HOST'];
    $baseUrl = rtrim(dirname($_SERVER['SCRIPT_NAME']), '/\\');
    $fullUrl = $scheme . '://' . $host . $baseUrl . '/uploads/products/' . $filename;
    respond(['image_url' => $fullUrl]);
}

try {
    if ($parts[0] === 'auth') {
        if ($parts[1] === 'demo-login' && $method === 'POST') {
            $query = $pdo->prepare('SELECT id, username, full_name, email, role, status FROM users WHERE username = ?');
            $query->execute([$demoLoginUsername]);
            $demoUser = $query->fetch();
            if (!$demoUser || $demoUser['status'] !== 'active' || $demoUser['role'] !== 'admin') {
                respond(['message' => 'The demo account is not available. Initialize the separate demo database.', 'code' => 'DEMO_ACCOUNT_UNAVAILABLE'], 503);
            }
            respond([
                'token' => tokenFor($demoUser, $jwtSecret),
                'user' => [
                    'id' => $demoUser['id'],
                    'username' => $demoUser['username'],
                    'full_name' => $demoUser['full_name'],
                    'email' => $demoUser['email'],
                    'role' => $demoUser['role'],
                    'demo_mode' => true,
                ],
            ]);
        }
        if ($parts[1] === 'login' && $method === 'POST') {
            $query = $pdo->prepare('SELECT * FROM users WHERE username = ?');
            $query->execute([inputValue($body, 'username', '')]);
            $user = $query->fetch();
            if (!$user || $user['status'] !== 'active' || !password_verify(inputValue($body, 'password', ''), $user['password'])) respond(['message' => 'Invalid username or password'], 401);
            respond(['token' => tokenFor($user, $jwtSecret), 'user' => ['id' => $user['id'], 'username' => $user['username'], 'full_name' => $user['full_name'], 'email' => $user['email'], 'role' => $user['role'], 'demo_mode' => true]]);
        }
        if ($parts[1] === 'forgot-password' && $method === 'POST') {
            respond(['message' => 'Password recovery is disabled in the public demo.'], 403);
        }
        if ($parts[1] === 'reset-password' && $method === 'GET') {
            respond(['valid' => false, 'message' => 'Password recovery is disabled in the public demo.'], 403);
        }
        if ($parts[1] === 'reset-password' && $method === 'POST') {
            respond(['message' => 'Password changes are disabled in the public demo.'], 403);
        }
        if ($parts[1] === 'me' && $method === 'GET') respond(currentUser($pdo, $jwtSecret));
    }

    $user = currentUser($pdo, $jwtSecret);
    $resource = $parts[0] ?? '';
    $id = $parts[1] ?? null;

    if ($resource === 'products') {
        if ($id === 'categories' && $method === 'GET') respond($pdo->query('SELECT * FROM categories ORDER BY name ASC')->fetchAll());
        if ($id === 'categories' && $method === 'POST') {
            if (!inputValue($body, 'name')) respond(['message' => 'Category name is required'], 400);
            $q = $pdo->prepare('INSERT INTO categories (name, description) VALUES (?, ?)');
            $q->execute([$body['name'], inputValue($body, 'description')]);
            respond(['id' => lastInsertedId($pdo, 'categories'), 'message' => 'Category created successfully'], 201);
        }
        if ($method === 'GET' && $id) {
            $q = $pdo->prepare('SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON p.category_id=c.id WHERE p.id=?');
            $q->execute([$id]); $row = $q->fetch(); if (!$row) respond(['message' => 'Product not found'], 404);
            // Add unit conversion data so the UI can offer purchase/selling units
            $row['units'] = getProductUnits($pdo, (int)$id);
            $row['purchase_units'] = getProductUnits($pdo, (int)$id, true, false);
            $row['sales_units'] = getProductUnits($pdo, (int)$id, false, true);
            $row['default_unit'] = getDefaultUnit($pdo, (int)$id);
            $row['stock_breakdown'] = stockBreakdown($pdo, (int)$id, (float)$row['stock_quantity'], (string)$row['base_unit']);
            // For backward compatibility, also include 'unit' field (alias for base_unit)
            $row['unit'] = $row['base_unit'];
            respond($row);
        }
        if ($method === 'GET') {
            $products = $pdo->query('SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON p.category_id=c.id ORDER BY p.created_at DESC')->fetchAll();
            // Add unit conversion data for each product
            foreach ($products as &$product) {
                $product['units'] = getProductUnits($pdo, (int)$product['id']);
                $product['purchase_units'] = getProductUnits($pdo, (int)$product['id'], true, false);
                $product['sales_units'] = getProductUnits($pdo, (int)$product['id'], false, true);
                $product['default_unit'] = getDefaultUnit($pdo, (int)$product['id']);
                $product['stock_breakdown'] = stockBreakdown($pdo, (int)$product['id'], (float)$product['stock_quantity'], (string)$product['base_unit']);
                // For backward compatibility
                $product['unit'] = $product['base_unit'];
            }
            unset($product);
            respond($products);
        }
        if ($method === 'POST' || $method === 'PUT') {
            // Handle both old 'unit' field and new 'base_unit' field
            $baseUnit = inputValue($body, 'base_unit', inputValue($body, 'unit', 'kg'));
            $fields = ['sku','name','category_id','base_unit','price','cost','stock_quantity','low_stock_threshold','status','supplier_name','image_url'];
            $values = [inputValue($body, 'sku'), inputValue($body, 'name'), inputValue($body, 'category_id'), $baseUnit, inputValue($body, 'price', 0), inputValue($body, 'cost', 0), inputValue($body, 'stock_quantity', 0), inputValue($body, 'low_stock_threshold', 10), inputValue($body, 'status', 'active'), inputValue($body, 'supplier_name'), inputValue($body, 'image_url')];
            if (!$values[0]) respond(['message' => 'SKU is required'], 400);
            if (!$values[1]) respond(['message' => 'Product name is required'], 400);
            if (!$values[2]) respond(['message' => 'Category is required'], 400);
            if (!$values[3]) respond(['message' => 'Base unit is required'], 400);
            $priceProvided = isset($body['price']) && $body['price'] !== '';
            $costProvided = isset($body['cost']) && $body['cost'] !== '';
            if ($priceProvided && (float)$values[4] < 0) respond(['message' => 'Suggested Retail price must be zero or greater'], 400);
            if ($costProvided && (float)$values[5] < 0) respond(['message' => 'Cost price must be zero or greater'], 400);
            if ($method === 'POST') {
                $q = $pdo->prepare('INSERT INTO products ('.implode(',', $fields).') VALUES (?,?,?,?,?,?,?,?,?,?,?)');
                $q->execute($values);
                $newId = lastInsertedId($pdo, 'products');
                // Create the configured units together with their purchase/sale flags and unit prices
                // (multiplicative units are inserted as supplied).
                $unitPayload = (!empty($body['units']) && is_array($body['units'])) ? $body['units'] : [];
                saveProductUnits($pdo, (int)$newId, $unitPayload, false);
                ensureBaseUnitRow($pdo, (int)$newId, (string)$baseUnit);
                respond(['id' => $newId, 'message' => 'Product created successfully'], 201);
            }
            $existing = $pdo->prepare('SELECT price,cost,stock_quantity,supplier_name,image_url FROM products WHERE id=?');
            $existing->execute([$id]);
            $productRow = $existing->fetch();
            if (!$productRow) respond(['message' => 'Product not found'], 404);
            $price = $priceProvided ? $values[4] : $productRow['price'];
            $cost = $costProvided ? $values[5] : $productRow['cost'];
            $supplierName = isset($body['supplier_name']) ? $values[9] : $productRow['supplier_name'];
            $imageUrl = array_key_exists('image_url', $body) ? $values[10] : $productRow['image_url'];
            $q = $pdo->prepare('UPDATE products SET sku=?,name=?,category_id=?,base_unit=?,price=?,cost=?,low_stock_threshold=?,status=?,supplier_name=?,image_url=? WHERE id=?');
            $q->execute([$values[0],$values[1],$values[2],$values[3],$price,$cost,$values[7],$values[8],$supplierName,$imageUrl,$id]);
            // Replace the whole unit configuration when the product form sends one,
            // then make sure the base unit itself is always selectable.
            if (!empty($body['units']) && is_array($body['units'])) {
                saveProductUnits($pdo, (int)$id, $body['units'], true);
            }
            ensureBaseUnitRow($pdo, (int)$id, (string)$values[3]);
            if (($productRow['image_url'] ?? null) !== $imageUrl) deleteImageFile($productRow['image_url'] ?? null);
            respond(['message' => 'Product updated successfully']);
        }
        if ($method === 'DELETE') {
            blockDemoAdminWrites($user);
            $q = $pdo->prepare('SELECT image_url FROM products WHERE id=?');
            $q->execute([$id]);
            $productRow = $q->fetch();
            if (!$productRow) respond(['message' => 'Product not found'], 404);
            $pdo->prepare('DELETE FROM products WHERE id=?')->execute([$id]);
            deleteImageFile($productRow['image_url'] ?? null);
            respond(['message' => 'Product deleted successfully']);
        }
        // Get product units
        if ($method === 'GET' && $id && isset($parts[2]) && $parts[2] === 'units') {
            $units = getProductUnits($pdo, (int)$id);
            respond($units);
        }
        // Create/update product units (admin only)
        if ($method === 'POST' && $id && isset($parts[2]) && $parts[2] === 'units') {
            requireAdmin($user);
            if (!is_array($body) || empty($body['units'])) respond(['message' => 'Units array is required'], 400);
            $product = $pdo->prepare('SELECT id FROM products WHERE id = ?');
            $product->execute([$id]);
            if (!$product->fetch()) respond(['message' => 'Product not found'], 404);
            foreach ($body['units'] as $unitData) {
                if (empty($unitData['unit']) || empty($unitData['multiplier_to_base'])) {
                    respond(['message' => 'Each unit must have unit and multiplier_to_base'], 400);
                }
            }
            saveProductUnits($pdo, (int)$id, $body['units'], false);
            respond(['message' => 'Product units updated successfully']);
        }
        // Delete a product unit (admin only)
        if ($method === 'DELETE' && $id && isset($parts[2]) && $parts[2] === 'units' && isset($parts[3])) {
            blockDemoAdminWrites($user);
            requireAdmin($user);
            $q = $pdo->prepare('DELETE FROM product_units WHERE product_id = ? AND unit = ?');
            $q->execute([$id, $parts[3]]);
            respond(['message' => 'Product unit deleted successfully']);
        }
        // Get batch details for a product (FIFO batch-level inventory)
        if ($method === 'GET' && $id && isset($parts[2]) && $parts[2] === 'batches') {
            $productRow = $pdo->prepare('SELECT shelf_life_days FROM products WHERE id = ?');
            $productRow->execute([(int)$id]);
            $productInfo = $productRow->fetch();
            $showSpoiledOnly = isset($_GET['spoiled']) && $_GET['spoiled'] === 'true';
            $threshold = (int)($productInfo['shelf_life_days'] ?? 5);
            $threshold = $threshold > 0 ? $threshold : 5;
            $where = 'WHERE product_id = ? AND quantity > 0';
            $params = [(int)$id];
            if ($showSpoiledOnly) {
                $where .= ' AND purchase_date <= DATE_SUB(CURDATE(), INTERVAL ' . $threshold . ' DAY)';
            }
            $where .= ' ORDER BY purchase_date ASC, id ASC';
            $stmt = $pdo->prepare("SELECT id, product_id, transaction_id, purchase_date, quantity, original_quantity, cost_per_base, created_at FROM inventory_batches $where");
            $stmt->execute($params);
            respond($stmt->fetchAll());
        }
    }

    if ($resource === 'users') {
        requireAdmin($user);
        if (in_array($method, ['POST', 'PUT', 'DELETE'], true)) blockDemoAdminWrites($user);
        if ($method === 'GET') { $sql = $id ? 'SELECT id,username,full_name,email,role,status,payroll,created_at FROM users WHERE id=?' : 'SELECT id,username,full_name,email,role,status,payroll,created_at FROM users ORDER BY created_at DESC'; $q = $pdo->prepare($sql); $q->execute($id ? [$id] : []); $rows = $q->fetchAll(); if ($id && !$rows) respond(['message'=>'User not found'],404); respond($id ? $rows[0] : $rows); }
        if ($method === 'POST') { $role = inputValue($body,'role','cashier'); $payroll = payrollAmountForRole($role, inputValue($body,'payroll',0)); $q = $pdo->prepare('INSERT INTO users (username,password,full_name,email,gmail_app_password,role,status,payroll) VALUES (?,?,?,?,?,?,?,?)'); $q->execute([$body['username'], password_hash($body['password'], PASSWORD_BCRYPT), inputValue($body,'full_name'), inputValue($body,'email'), inputValue($body,'gmail_app_password'), $role, inputValue($body,'status','active'), $payroll]); respond(['id'=>lastInsertedId($pdo,'users'),'message'=>'User created successfully'],201); }
        if ($method === 'PUT') { $role = inputValue($body,'role','cashier'); $payroll = payrollAmountForRole($role, inputValue($body,'payroll',0)); $status = inputValue($body,'status','active'); $cur=$pdo->prepare('SELECT role,status FROM users WHERE id=?'); $cur->execute([$id]); $target=$cur->fetch(); if (!$target) respond(['message'=>'User not found'],404); if ($target['role']==='admin' && $status !== $target['status']) respond(['message'=>'Admin status cannot be changed'],400); $sets='full_name=?,email=?,gmail_app_password=?,role=?,status=?,payroll=?'; $values=[inputValue($body,'full_name'),inputValue($body,'email'),inputValue($body,'gmail_app_password'),$role,$status,$payroll]; if (!empty($body['password'])) {$sets.=',password=?';$values[]=password_hash($body['password'],PASSWORD_BCRYPT);} $values[]=$id; $pdo->prepare("UPDATE users SET $sets WHERE id=?")->execute($values); respond(['message'=>'User updated successfully']); }
        if ($method === 'DELETE') { if ((int)$id === (int)$user['id']) respond(['message'=>'You cannot delete your own account'],400); $pdo->prepare('DELETE FROM users WHERE id=?')->execute([$id]); respond(['message'=>'User deleted successfully']); }
    }

    if ($resource === 'payrolls') {
        requireAdmin($user);
        if ($method === 'GET') {
            $q = $pdo->query("SELECT p.id,p.user_id,p.period,p.amount,p.notes,p.created_at,u.username,u.full_name,u.role FROM payrolls p JOIN users u ON p.user_id=u.id ORDER BY p.period DESC, p.created_at DESC");
            respond($q->fetchAll());
        }
        if ($method === 'POST') {
            blockDemoAdminWrites($user);
            $userId = (int)inputValue($body, 'user_id', 0);
            $period = trim((string)inputValue($body, 'period', ''));
            $amount = (float)inputValue($body, 'amount', 0);
            $notes = inputValue($body, 'notes');
            if ($userId <= 0) respond(['message' => 'Select a manager or cashier'], 400);
            if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $period)) respond(['message' => 'Pay date is required (YYYY-MM-DD)'], 400);
            [$pY, $pM, $pD] = array_map('intval', explode('-', $period));
            if (!checkdate($pM, $pD, $pY)) respond(['message' => 'Pay date is invalid'], 400);
            if ($amount <= 0) respond(['message' => 'Payroll amount must be greater than zero'], 400);
            $employee = $pdo->prepare('SELECT id, role FROM users WHERE id=?');
            $employee->execute([$userId]);
            $row = $employee->fetch();
            if (!$row) respond(['message' => 'User not found'], 404);
            if ($row['role'] !== 'manager' && $row['role'] !== 'cashier') respond(['message' => 'Payroll can only be inserted for managers and cashiers'], 400);
            try {
                $q = $pdo->prepare('INSERT INTO payrolls (user_id, period, amount, notes) VALUES (?,?,?,?)');
                $q->execute([$userId, $period, $amount, $notes]);
            } catch (PDOException $error) {
                if ((int)$error->errorInfo[1] === 1062) respond(['message' => 'Payroll for this employee on this date already exists'], 409);
                throw $error;
            }
            respond(['id' => lastInsertedId($pdo, 'payrolls'), 'message' => 'Payroll inserted successfully'], 201);
        }
        if ($method === 'DELETE') {
            blockDemoAdminWrites($user);
            if (!$id) respond(['message' => 'Payroll record is required'], 400);
            $q = $pdo->prepare('DELETE FROM payrolls WHERE id=?');
            $q->execute([$id]);
            respond(['message' => 'Payroll record deleted successfully']);
        }
    }

    if ($resource === 'settings') {
        if ($method === 'GET') { $settings=[]; foreach ($pdo->query('SELECT setting_key,setting_value FROM settings') as $row) $settings[$row['setting_key']]=$row['setting_value']; $settings['currency']='PHP'; respond($settings); }
        blockDemoAdminWrites($user);
        requireAdmin($user); foreach ($body as $key=>$value) if ($key !== 'currency') $pdo->prepare('INSERT INTO settings (setting_key,setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)')->execute([$key,$value]); $pdo->prepare('INSERT INTO settings (setting_key,setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)')->execute(['currency','PHP']); respond(['message'=>'Settings updated successfully']);
    }

    if ($resource === 'transactions') {
        if ($id === 'restock' && $method === 'POST') {
            $requestItems = isset($body['items']) && is_array($body['items']) ? $body['items'] : [[
                'product_id' => inputValue($body, 'product_id'),
                'quantity' => inputValue($body, 'quantity', 0),
                'unit' => inputValue($body, 'unit', null),
                'unit_cost' => inputValue($body, 'unit_cost'),
                'retail_price' => inputValue($body, 'retail_price'),
            ]];
            if (!$requestItems || array_filter($requestItems, fn($item) => !inputValue($item, 'product_id') || (float)inputValue($item, 'quantity', 0) <= 0)) {
                respond(['message' => 'A valid product and quantity are required for every item'], 400);
            }
            $pdo->beginTransaction();
            $supplier = trim((string)inputValue($body, 'supplier_name', '')) ?: 'Supplier';
            $restockItems = []; $total = 0;
            
            foreach ($requestItems as $item) {
                $productId = (int)inputValue($item, 'product_id');
                $q = $pdo->prepare('SELECT id, name, base_unit, cost, price FROM products WHERE id=? FOR UPDATE');
                $q->execute([$productId]);
                $product = $q->fetch();
                if (!$product) { $pdo->rollBack(); respond(['message' => 'Product not found'], 404); }
                
                $quantity = (float)inputValue($item, 'quantity', 0);
                $unit = inputValue($item, 'unit', null);
                if (!$unit) {
                    $defaultUnit = getDefaultUnit($pdo, $productId);
                    $unit = $defaultUnit['unit'] ?? $product['base_unit'];
                }
                
                $unitRow = resolveProductUnit($pdo, $productId, (string)$unit, (string)$product['base_unit'], true, false);
                if (!$unitRow) {
                    $pdo->rollBack();
                    respond(['message' => "Unit '$unit' is not a valid purchase unit for {$product['name']}"], 400);
                }
                $conversionRate = (float)$unitRow['multiplier_to_base'];
                if (!unitAllowsDecimals((string)$unitRow['unit']) && floor($quantity) != $quantity) {
                    $pdo->rollBack();
                    respond(['message' => 'Quantity for ' . unitDisplayName($unitRow) . ' must be a whole number'], 400);
                }
                
                $baseQuantity = round($quantity * $conversionRate, 4);
                // Unit cost semantics: â‚±2,000 per sack stays per sack (pricing is independent of the conversion factor).
                // Prefer the per-purchase-unit cost; fall back to total_cost / quantity; then to base-unit cost Ã— multiplier.
                $unitCost = inputValue($item, 'unit_cost', null);
                $totalCost = inputValue($item, 'total_cost', null);
                if (($unitCost === null || $unitCost === '') && $totalCost !== null && $totalCost !== '' && $quantity > 0) {
                    $unitCost = (float)$totalCost / $quantity;
                }
                $cost = ($unitCost === null || $unitCost === '') ? (float)$product['cost'] * $conversionRate : (float)$unitCost;
                if ($cost < 0) { $pdo->rollBack(); respond(['message' => 'Cost price must be zero or greater'], 400); }
                $retail = inputValue($item, 'retail_price', null);
                $retailPrice = ($retail === null || $retail === '') ? (float)$product['price'] : (float)$retail;
                if ($retailPrice < 0) { $pdo->rollBack(); respond(['message' => 'Suggested Retail price must be zero or greater'], 400); }
                
                $lineTotal = $quantity * $cost;
                $total += $lineTotal;
                $restockItems[] = [$product, $quantity, $unit, $conversionRate, $baseQuantity, $cost, $lineTotal, $retailPrice];
            }
            
            $invoice = 'INV-'.date('YmdHis').'-'.random_int(100,999);
            $q = $pdo->prepare("INSERT INTO transactions (invoice_no,user_id,customer_name,subtotal,discount,tax,total,payment_method,status,transaction_type,supplier_name) VALUES (?,?,?,?,0,0,?,'other','completed','restock',?)");
            $q->execute([$invoice,$user['id'],$supplier,$total,$total,$supplier]);
            $txId = lastInsertedId($pdo, 'transactions');
            
            // Restock lines record the cost they were bought at as well.
            $itemColumns = 'transaction_id,product_id,product_name,quantity,unit,conversion_rate,base_quantity,unit_price,line_total';
            $itemPlaceholders = '?,?,?,?,?,?,?,?,?';
            if ($transactionItemCostColumn) { $itemColumns .= ',cost_price'; $itemPlaceholders .= ',?'; }
            $itemQ = $pdo->prepare("INSERT INTO transaction_items ($itemColumns) VALUES ($itemPlaceholders)");
            $stockQ = $pdo->prepare("UPDATE products SET stock_quantity=stock_quantity+?,price=?,cost=?,supplier_name=COALESCE(?,supplier_name),status='active' WHERE id=?");
            $batchInsertQ = hasTable($pdo, 'inventory_batches') ? $pdo->prepare("INSERT INTO inventory_batches (product_id, transaction_id, purchase_date, quantity, original_quantity, cost_per_base) VALUES (?, ?, CURRENT_DATE, ?, ?, ?)") : null;
            
            foreach ($restockItems as [$product, $quantity, $unit, $conversionRate, $baseQuantity, $cost, $lineTotal, $retailPrice]) {
                // products.cost is the cost per BASE unit (used for profit reporting) — derive it from the purchase line.
                $costPerBase = $baseQuantity > 0 ? round($lineTotal / $baseQuantity, 4) : (float)$product['cost'];
                $lineValues = [$txId, $product['id'], $product['name'], $quantity, $unit, $conversionRate, $baseQuantity, $cost, $lineTotal];
                if ($transactionItemCostColumn) { $lineValues[] = $costPerBase; }
                $itemQ->execute($lineValues);
                $stockQ->execute([$baseQuantity, $retailPrice, $costPerBase, inputValue($body, 'supplier_name'), $product['id']]);
                // Create a batch for this purchase (FIFO source for future sales)
                if ($batchInsertQ && $baseQuantity > 0) {
                    $batchInsertQ->execute([$product['id'], $txId, $baseQuantity, $baseQuantity, $costPerBase]);
                }
            }
            $pdo->commit();
            respond(['id'=>$txId,'invoice_no'=>$invoice,'message'=>'Products restocked successfully'],201);
        }
        if ($method === 'GET' && $id) { $ownerFilter=$user['role']==='cashier'?' AND t.user_id='.((int)$user['id']):''; $q=$pdo->prepare('SELECT t.*,u.username AS cashier_username FROM transactions t LEFT JOIN users u ON t.user_id=u.id WHERE t.id=?'.$ownerFilter);$q->execute([$id]);$tx=$q->fetch();if(!$tx)respond(['message'=>'Transaction not found'],404);$q=$pdo->prepare('SELECT * FROM transaction_items WHERE transaction_id=?');$q->execute([$id]);$tx['items']=$q->fetchAll();respond($tx); }
        if ($method === 'GET') { $where=[];$values=[];foreach(['from'=>'t.created_at >= ?','to'=>'t.created_at <= ?','status'=>'t.status = ?'] as $key=>$condition) if (!empty($_GET[$key])) {$where[]=$condition;$values[]=$_GET[$key];} if (!empty($_GET['q'])) {$where[]='(t.invoice_no LIKE ? OR t.customer_name LIKE ?)';$values[]='%'.$_GET['q'].'%';$values[]='%'.$_GET['q'].'%';} if ($user['role']==='cashier') $where[]='t.user_id='.(int)$user['id']; $sql='SELECT t.*,u.username AS cashier_username FROM transactions t LEFT JOIN users u ON t.user_id=u.id WHERE '.($where?implode(' AND ',$where):'1').' ORDER BY t.created_at DESC LIMIT 500';$q=$pdo->prepare($sql);$q->execute($values);respond($q->fetchAll()); }
        // Voiding keeps the row for auditing but marks it invalid: every sales report and
        // chart filters status='completed', so a voided sale drops out of revenue, profit
        // and top-product figures. Only a completed transaction can be voided, and only
        // once. Admin/manager only.
        if ($method === 'PATCH' && ($parts[2] ?? '') === 'void') {
            blockDemoAdminWrites($user);
            requireManager($user);
            $q = $pdo->prepare('SELECT status FROM transactions WHERE id=?');
            $q->execute([$id]);
            $currentStatus = $q->fetchColumn();
            if ($currentStatus === false) respond(['message'=>'Transaction not found'],404);
            if ($currentStatus !== 'completed') respond(['message'=>'Only completed transactions can be voided (current status: '.$currentStatus.')'],400);
            // Guarded update: a concurrent request cannot void it twice.
            $pdo->prepare("UPDATE transactions SET status='voided' WHERE id=? AND status='completed'")->execute([$id]);
            respond(['message'=>'Transaction voided successfully']);
        }
        // Unvoid is the counterpart of void: a voided transaction goes back to 'completed'
        // so it counts in the sales figures again. Only a voided row can be restored.
        // Admin/manager only.
        if ($method === 'PATCH' && ($parts[2] ?? '') === 'unvoid') {
            blockDemoAdminWrites($user);
            requireManager($user);
            $q = $pdo->prepare('SELECT status FROM transactions WHERE id=?');
            $q->execute([$id]);
            $currentStatus = $q->fetchColumn();
            if ($currentStatus === false) respond(['message'=>'Transaction not found'],404);
            if ($currentStatus !== 'voided') respond(['message'=>'Only voided transactions can be restored (current status: '.$currentStatus.')'],400);
            // Guarded update: a concurrent request cannot restore it twice.
            $pdo->prepare("UPDATE transactions SET status='completed' WHERE id=? AND status='voided'")->execute([$id]);
            respond(['message'=>'Transaction restored successfully']);
        }
        // Delete removes the transaction and its item lines for good â€” no audit trail.
        // The item rows are deleted explicitly so this also works where the foreign key
        // was created without ON DELETE CASCADE. Admin/manager only.
        if ($method === 'DELETE') {
            blockDemoAdminWrites($user);
            requireManager($user);
            $q = $pdo->prepare('SELECT id FROM transactions WHERE id=?');
            $q->execute([$id]);
            if (!$q->fetch()) respond(['message'=>'Transaction not found'],404);
            $pdo->beginTransaction();
            $pdo->prepare('DELETE FROM transaction_items WHERE transaction_id=?')->execute([$id]);
            $pdo->prepare('DELETE FROM transactions WHERE id=?')->execute([$id]);
            $pdo->commit();
            respond(['message'=>'Transaction deleted successfully']);
        }
        if ($method === 'POST') {
            if (empty($body['items']) || !is_array($body['items'])) respond(['message'=>'At least one item is required'],400);
            $pdo->beginTransaction();
            $subtotal = 0;
            $baseTotals = [];
            $processedItems = [];
            
            foreach($body['items'] as $item) {
                $productId = (int)inputValue($item, 'product_id', 0);
                if ($productId <= 0) {
                    $pdo->rollBack();
                    respond(['message'=>'Invalid product_id'], 400);
                }
                
                $product = $pdo->prepare('SELECT id, name, base_unit, stock_quantity, price, cost FROM products WHERE id=? FOR UPDATE');
                $product->execute([$productId]);
                $product = $product->fetch();
                if (!$product) {
                    $pdo->rollBack();
                    respond(['message'=>'Product not found'], 404);
                }
                
                $quantity = (float)inputValue($item, 'quantity', 0);
                if ($quantity <= 0) {
                    $pdo->rollBack();
                    respond(['message'=>'Quantity must be greater than 0'], 400);
                }
                
                $unit = inputValue($item, 'unit', null);
                if (!$unit) {
                    $defaultUnit = getDefaultUnit($pdo, $productId, false, true);
                    $unit = $defaultUnit['unit'] ?? $product['base_unit'];
                }
                
                // Resolve the unit against the DB â€” never trust a conversion factor sent from the client.
                $unitRow = resolveProductUnit($pdo, $productId, (string)$unit, (string)$product['base_unit'], false, true);
                if (!$unitRow) {
                    $pdo->rollBack();
                    respond(['message' => "Unit '$unit' is not a valid selling unit for {$product['name']}"], 400);
                }
                $conversionRate = (float)$unitRow['multiplier_to_base'];
                if (!unitAllowsDecimals((string)$unitRow['unit']) && floor($quantity) != $quantity) {
                    $pdo->rollBack();
                    respond(['message' => 'Quantity for ' . unitDisplayName($unitRow) . ' must be a whole number'], 400);
                }
                
                // Pricing is independent of the conversion factor: a configured unit price wins,
                // otherwise the client-sent per-unit price is honoured, otherwise base suggested retail price.
                $unitPrice = (float)inputValue($item, 'unit_price', $product['price']);
                if ($unitRow['price'] !== null && (float)$unitRow['price'] > 0) {
                    $unitPrice = (float)$unitRow['price'];
                }
                
                $baseQuantity = round($quantity * $conversionRate, 4);
                
                if (!isset($baseTotals[$productId])) {
                    $baseTotals[$productId] = 0;
                }
                $baseTotals[$productId] += $baseQuantity;
                
                $line = round($quantity * $unitPrice, 2);
                $subtotal += $line;
                
                $processedItems[] = [
                    'product_id' => $productId,
                    'product_name' => $item['product_name'] ?? $product['name'],
                    'quantity' => $quantity,
                    'unit' => $unit,
                    'conversion_rate' => $conversionRate,
                    'base_quantity' => $baseQuantity,
                    'unit_price' => $unitPrice,
                    'line_total' => $line,
                    // Cost per BASE unit at the moment of the sale: reported profit never
                    // changes afterwards, even when the product is restocked.
                    'cost_price' => (float)$product['cost']
                ];
            }
            
            foreach ($baseTotals as $productId => $requiredBaseQty) {
                $product = $pdo->prepare('SELECT stock_quantity, base_unit, name FROM products WHERE id=?');
                $product->execute([$productId]);
                $product = $product->fetch();
                if ((float)$product['stock_quantity'] < $requiredBaseQty) {
                    $pdo->rollBack();
                    respond(['message' => 'Insufficient stock for ' . $product['name'] . '. Available: ' . formatQuantity((float)$product['stock_quantity']) . ' ' . $product['base_unit'] . '. Required: ' . formatQuantity((float)$requiredBaseQty) . ' ' . $product['base_unit'] . '.'], 400);
                }
            }
            
            $discount = (float)inputValue($body, 'discount', 0);
            $tax = (float)inputValue($body, 'tax', 0);
            $invoice = 'INV-' . date('YmdHis') . '-' . random_int(100, 999);
            $total = round($subtotal - $discount + $tax, 2);
            
            $q = $pdo->prepare("INSERT INTO transactions (invoice_no, user_id, customer_name, subtotal, discount, tax, total, payment_method, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed')");
            $q->execute([$invoice, $user['id'], inputValue($body, 'customer_name', 'Walk-in Customer'), $subtotal, $discount, $tax, $total, inputValue($body, 'payment_method', 'cash')]);
            $txId = lastInsertedId($pdo, 'transactions');
            
            // The cost captured per line is stored when the column is available.
            $itemColumns = 'transaction_id, product_id, product_name, quantity, unit, conversion_rate, base_quantity, unit_price, line_total';
            $itemPlaceholders = '?, ?, ?, ?, ?, ?, ?, ?, ?';
            if ($transactionItemCostColumn) { $itemColumns .= ', cost_price'; $itemPlaceholders .= ', ?'; }
            $itemQ = $pdo->prepare("INSERT INTO transaction_items ($itemColumns) VALUES ($itemPlaceholders)");
            $stockQ = $pdo->prepare("UPDATE products SET stock_quantity = GREATEST(stock_quantity - ?, 0), status = IF(stock_quantity <= 0, 'inactive', status) WHERE id = ?");
            $batchExists = hasTable($pdo, 'inventory_batches');
            $batchDeductQ = $batchExists ? $pdo->prepare('SELECT id, quantity FROM inventory_batches WHERE product_id = ? AND quantity > 0 ORDER BY purchase_date ASC, id ASC') : null;
            $batchUpdateQ = $batchExists ? $pdo->prepare('UPDATE inventory_batches SET quantity = ? WHERE id = ?') : null;
            $batchDeleteQ = $batchExists ? $pdo->prepare('DELETE FROM inventory_batches WHERE id = ?') : null;
            $batchRecalcQ = $batchExists ? $pdo->prepare('UPDATE products SET stock_quantity = (SELECT COALESCE(SUM(quantity), 0) FROM inventory_batches WHERE product_id = ?) WHERE id = ?') : null;
            
            foreach ($processedItems as $item) {
                $lineValues = [$txId, $item['product_id'], $item['product_name'], $item['quantity'], $item['unit'], $item['conversion_rate'], $item['base_quantity'], $item['unit_price'], $item['line_total']];
                if ($transactionItemCostColumn) { $lineValues[] = $item['cost_price']; }
                $itemQ->execute($lineValues);
                if (!empty($item['product_id'])) {
                    $baseQty = (float)$item['base_quantity'];
                    if ($baseQty > 0 && $batchExists) {
                        // FIFO: deduct from oldest batches first
                        $batchDeductQ->execute([$item['product_id']]);
                        $batches = $batchDeductQ->fetchAll();
                        $toDeduct = $baseQty;
                        foreach ($batches as $batch) {
                            if ($toDeduct <= 0) break;
                            $currentQty = (float)$batch['quantity'];
                            $take = min($currentQty, $toDeduct);
                            $newQty = $currentQty - $take;
                            if ($newQty <= 0) {
                                $batchDeleteQ->execute([$batch['id']]);
                            } else {
                                $batchUpdateQ->execute([$newQty, $batch['id']]);
                            }
                            $toDeduct -= $take;
                        }
                        // Recalculate aggregate stock_quantity from remaining batches
                        $batchRecalcQ->execute([$item['product_id'], $item['product_id']]);
                    } else {
                        // Fallback: simple stock deduction when batches table doesn't exist
                        $stockQ->execute([$baseQty, $item['product_id']]);
                    }
                }
            }
            
            $pdo->commit();
            respond(['id'=>$txId, 'invoice_no'=>$invoice, 'total'=>$total, 'message'=>'Transaction recorded successfully'], 201);
        }
    }

    if ($resource === 'reports') {
        if ($id === 'dashboard') {
            $validPeriods = ['daily','weekly','monthly','annual'];
            $salesPeriod = in_array($_GET['sales_period'] ?? '', $validPeriods, true) ? $_GET['sales_period'] : 'daily';
            $topProductsPeriod = in_array($_GET['top_products_period'] ?? '', $validPeriods, true) ? $_GET['top_products_period'] : 'daily';
            $ownerFilter=$user['role']==='cashier'?' AND user_id='.(int)$user['id']:'';
            $ownerFilterAlias=$user['role']==='cashier'?' AND t.user_id='.(int)$user['id']:'';
            // Profit is an owner/manager figure â€” cashier accounts never receive it.
            $showProfit = $user['role'] !== 'cashier';
            $profitJoin = $showProfit ? profitJoinSql() : '';
            $profitTotalExpr = $showProfit ? 'COALESCE(SUM(pr.profit),0)' : 'NULL';
            $today=$pdo->query("SELECT COALESCE(SUM(t.total),0) total_sales,COUNT(*) total_transactions,$profitTotalExpr total_profit FROM transactions t".$profitJoin." WHERE DATE(t.created_at)=CURDATE() AND t.status='completed' AND t.transaction_type='sale'".$ownerFilter)->fetch();
            $month=$pdo->query("SELECT COALESCE(SUM(t.total),0) total_sales FROM transactions t WHERE MONTH(t.created_at)=MONTH(CURDATE()) AND YEAR(t.created_at)=YEAR(CURDATE()) AND t.status='completed' AND t.transaction_type='sale'".$ownerFilter)->fetch();
            $stats=$pdo->query("SELECT COUNT(*) total_products,SUM(stock_quantity<=low_stock_threshold) low_stock_count FROM products WHERE status='active'")->fetch();
            $alerts=$pdo->query("SELECT id,name,stock_quantity,low_stock_threshold,CASE WHEN stock_quantity=0 THEN 'out_of_stock' ELSE 'low_stock' END alert_type FROM products WHERE status='active' AND stock_quantity<=low_stock_threshold ORDER BY stock_quantity ASC")->fetchAll();
            $notifications=[];foreach($alerts as $alert)$notifications[]=['type'=>$alert['alert_type'],'message'=>$alert['name'].($alert['alert_type']==='out_of_stock'?' is out of stock':' is running low'),'product_id'=>$alert['id']];
            $salesRange = rangeForPeriod($salesPeriod, 't.created_at');
            $salesTrend = $pdo->query("SELECT {$salesRange['groupExpr']} date,SUM(t.total) total,$profitTotalExpr profit FROM transactions t".$profitJoin." WHERE t.status='completed' AND t.transaction_type='sale' AND {$salesRange['rangeCondition']}".$ownerFilter." GROUP BY {$salesRange['groupExpr']} ORDER BY MIN(t.created_at)")->fetchAll();
            // Cast aggregates to numbers so charts (Recharts) receive real JSON numbers
            foreach ($salesTrend as &$trendRow) { $trendRow['total']=(float)$trendRow['total']; $trendRow['profit']=$showProfit?(float)$trendRow['profit']:null; } unset($trendRow);
            $topProductsRange = rangeForPeriod($topProductsPeriod, 't.created_at');
            $topProducts = $pdo->query("SELECT ti.product_name,SUM(ti.quantity) total_qty,SUM(ti.line_total) total_revenue FROM transaction_items ti JOIN transactions t ON ti.transaction_id=t.id WHERE t.status='completed' AND t.transaction_type='sale' AND {$topProductsRange['rangeCondition']}".$ownerFilterAlias." GROUP BY ti.product_name ORDER BY total_revenue DESC LIMIT 5")->fetchAll();
            // FIFO batch spoilage: batches aged 5+ days with remaining stock
            $spoiledCount = 0;
            $spoiledNotifications = [];
            if ($showProfit) {
                $spoiledStats = $pdo->query("SELECT COUNT(*) AS spoiled_count FROM inventory_batches ib JOIN products p ON p.id = ib.product_id WHERE ib.quantity > 0 AND ib.purchase_date <= DATE_SUB(CURDATE(), INTERVAL 5 DAY)")->fetch();
                $spoiledCount = (int)($spoiledStats['spoiled_count'] ?? 0);
                $spoiledAlerts = $pdo->query("SELECT p.id AS product_id, p.name, p.base_unit AS unit, SUM(ib.quantity) AS remaining_quantity, MIN(ib.purchase_date) AS oldest_purchase_date FROM inventory_batches ib JOIN products p ON p.id = ib.product_id WHERE ib.quantity > 0 AND ib.purchase_date <= DATE_SUB(CURDATE(), INTERVAL 5 DAY) GROUP BY p.id, p.name, p.base_unit ORDER BY oldest_purchase_date ASC, p.name ASC LIMIT 10")->fetchAll();
                foreach ($spoiledAlerts as $s) $spoiledNotifications[] = ['type'=>'spoiled','product_id'=>$s['product_id'],'message'=>'Spoiled alert: '.$s['name'].' has '.((int)$s['remaining_quantity']).' '.$s['unit'].' of stock aged 5+ days'];
            }
            respond(['today_sales'=>$today['total_sales'],'today_transactions'=>$today['total_transactions'],'today_profit'=>$showProfit?(float)$today['total_profit']:null,'month_sales'=>$month['total_sales'],'total_products'=>$stats['total_products']??0,'low_stock_count'=>$stats['low_stock_count']??0,'spoiled_count'=>$showProfit?$spoiledCount:0,'alerts'=>$alerts,'notifications'=>$notifications,'spoiled_notifications'=>$showProfit?$spoiledNotifications:[],'recent_transactions'=>$pdo->query("SELECT id,invoice_no,customer_name,total,payment_method,created_at FROM transactions WHERE status='completed' AND transaction_type='sale'".$ownerFilter." ORDER BY created_at DESC LIMIT 8")->fetchAll(),'sales_last_7_days'=>$salesTrend,'top_products'=>$topProducts]);
        }
        if ($id === 'inventory') { if ($user['role']==='cashier') respond(['message'=>'Inventory reports are not available for cashier accounts'],403); respond($pdo->query('SELECT p.id,p.name,c.name category_name,p.stock_quantity,p.low_stock_threshold,p.price,(p.stock_quantity*p.cost) stock_value FROM products p LEFT JOIN categories c ON p.category_id=c.id ORDER BY p.stock_quantity')->fetchAll()); }
        if ($id === 'sales') { // Profit is withheld from cashier accounts (see the dashboard endpoint).
            $showProfit=$user['role']!=='cashier';$profitJoin=$showProfit?profitJoinSql():'';$profitSelect=$showProfit?'COALESCE(SUM(pr.profit),0)':'NULL';
            $from=$_GET['from']??'';$to=$_GET['to']??'';$where="t.status='completed' AND t.transaction_type='sale'";$values=[];if($user['role']==='cashier')$where.=' AND t.user_id='.(int)$user['id'];if($from){$where.=' AND t.created_at >= ?';$values[]=$from;}if($to){$where.=' AND t.created_at <= ?';$values[]=$to;}$q=$pdo->prepare("SELECT DATE(t.created_at) date,SUM(t.total) total,COUNT(*) count,$profitSelect profit FROM transactions t".$profitJoin." WHERE $where GROUP BY DATE(t.created_at) ORDER BY date");$q->execute($values);$dates=$q->fetchAll();foreach ($dates as &$dateRow) { $dateRow['total']=(float)$dateRow['total']; $dateRow['profit']=$showProfit?(float)$dateRow['profit']:null; } unset($dateRow);$q=$pdo->prepare("SELECT c.name category,SUM(ti.line_total) total FROM transaction_items ti JOIN transactions t ON ti.transaction_id=t.id LEFT JOIN products p ON ti.product_id=p.id LEFT JOIN categories c ON p.category_id=c.id WHERE $where GROUP BY c.name ORDER BY total DESC");$q->execute($values);$categories=$q->fetchAll();$q=$pdo->prepare("SELECT t.payment_method,SUM(t.total) total,COUNT(*) count FROM transactions t WHERE $where GROUP BY t.payment_method");$q->execute($values);$payments=$q->fetchAll();$q=$pdo->prepare("SELECT COALESCE(SUM(t.total),0) grand_total,COUNT(*) total_transactions,$profitSelect total_profit FROM transactions t".$profitJoin." WHERE $where");$q->execute($values);$totals=$q->fetch();if(!$showProfit)$totals['total_profit']=null;respond(['sales_by_date'=>$dates,'sales_by_category'=>$categories,'sales_by_payment'=>$payments,'totals'=>$totals]);}
        if ($id === 'spoiled-alerts') { // FIFO batch spoilage alerts
            requireManager($user);
            $batchExists = hasTable($pdo, 'inventory_batches');
            if (!$batchExists) {
                respond([]);
            }
            $where = "WHERE ib.quantity > 0 AND ib.purchase_date <= DATE_SUB(CURDATE(), INTERVAL 5 DAY)";
            $alerts = $pdo->query("SELECT p.id AS product_id, p.name, p.base_unit AS unit, p.stock_quantity, p.shelf_life_days, SUM(ib.quantity) AS remaining_quantity, MIN(ib.purchase_date) AS oldest_purchase_date, MAX(ib.purchase_date) AS newest_purchase_date, COUNT(*) AS batch_count FROM inventory_batches ib JOIN products p ON p.id = ib.product_id $where GROUP BY p.id, p.name, p.base_unit, p.stock_quantity, p.shelf_life_days ORDER BY oldest_purchase_date ASC, p.name ASC")->fetchAll();
            $result = array_map(function($row) { return ['product_id'=>(int)$row['product_id'],'name'=>$row['name'],'unit'=>$row['unit'],'remaining_quantity'=>(float)$row['remaining_quantity'],'stock_quantity'=>(float)$row['stock_quantity'],'shelf_life_days'=>(int)$row['shelf_life_days'],'oldest_purchase_date'=>$row['oldest_purchase_date'],'newest_purchase_date'=>$row['newest_purchase_date'],'batch_count'=>(int)$row['batch_count']]; }, $alerts);
            respond($result);
        }
    }
    respond(['message' => 'Endpoint not found'], 404);
} catch (PDOException $error) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    error_log('VegieTrack API request failed: ' . $error->getMessage());
    respond(['message' => 'Request could not be completed'], 500);
}
