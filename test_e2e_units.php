<?php
/**
 * End-to-end multi-unit conversion test for VegieTrack API.
 * Run: php test_e2e_units.php
 */
$BASE = 'http://localhost/VegieTrack/api';
$PASS = 0; $FAIL = 0;

function req($method, $path, $body = null, $token = null) {
    global $BASE;
    $opts = ['http' => ['method' => $method, 'ignore_errors' => true, 'header' => "Content-Type: application/json\r\n", 'timeout' => 20]];
    if ($token) $opts['http']['header'] .= "X-Auth-Token: $token\r\n";
    if ($body !== null) $opts['http']['content'] = json_encode($body);
    $ctx = stream_context_create($opts);
    $raw = @file_get_contents($BASE . $path, false, $ctx);
    $code = 0;
    if (isset($http_response_header) && preg_match('/HTTP\/\S+\s+(\d+)/', $http_response_header[0], $m)) $code = (int)$m[1];
    return ['code' => $code, 'json' => json_decode((string)$raw, true), 'raw' => (string)$raw];
}
function check($name, $cond, $detail = '') {
    global $PASS, $FAIL;
    if ($cond) { $PASS++; echo "PASS  $name\n"; }
    else { $FAIL++; echo "FAIL  $name  $detail\n"; }
}

// ---- 1. Login ----
$r = req('POST', '/auth/demo-login', []);
check('login', $r['code'] === 200 && !empty($r['json']['token']), json_encode($r));
$token = $r['json']['token'] ?? '';

// ---- 2. Products list must not 500 (regression for getProductUnits bug) ----
$r = req('GET', '/products', null, $token);
check('GET /products returns 200', $r['code'] === 200 && is_array($r['json']), "code={$r['code']} body=" . substr($r['raw'], 0, 200));
$products = is_array($r['json']) && isset($r['json'][0]) ? $r['json'] : [];
$unitsIncluded = false;
foreach ($products as $p) { if (isset($p['units'])) { $unitsIncluded = true; break; } }
check('products include units[]', $unitsIncluded);

// ---- 3. Find or create Rice (base kg, 1 sack = 50 kg) ----
$rice = null;
foreach ($products as $p) { if (stripos($p['name'], 'rice') !== false) { $rice = $p; break; } }
// Categories: creating a product requires one (endpoint is /products/categories)
$rc = req('GET', '/products/categories', null, $token);
$cats = is_array($rc['json']) ? $rc['json'] : [];
$catId = $cats[0]['id'] ?? null;
if (!$rice) {
    $r = req('POST', '/products', ['sku' => 'RICE-E2E', 'name' => 'Rice E2E', 'category_id' => $catId, 'base_unit' => 'kg', 'price' => 60, 'cost' => 45, 'low_stock_threshold' => 50,
        'units' => [
            ['unit' => 'kg', 'label' => 'Kilogram', 'multiplier_to_base' => 1, 'is_purchase_unit' => 0, 'is_sales_unit' => 1],
            ['unit' => 'sack', 'label' => 'Sack (50kg)', 'multiplier_to_base' => 50, 'is_purchase_unit' => 1, 'is_sales_unit' => 1],
            ['unit' => 'pack', 'label' => 'Pack (5kg)', 'multiplier_to_base' => 5, 'is_purchase_unit' => 1, 'is_sales_unit' => 1],
        ]], $token);
    check('create Rice product', $r['code'] === 201 || $r['code'] === 200, json_encode($r));
    $riceId = $r['json']['id'] ?? null;
} else {
    $riceId = $rice['id'];
    $r = req('PUT', '/products/' . $riceId, [
        'name' => $rice['name'], 'sku' => $rice['sku'], 'price' => $rice['price'], 'cost' => $rice['cost'],
        'category_id' => $rice['category_id'], 'base_unit' => 'kg', 'stock_quantity' => $rice['stock_quantity'],
        'units' => [
        ['unit' => 'kg', 'label' => 'Kilogram', 'multiplier_to_base' => 1, 'is_purchase_unit' => 0, 'is_sales_unit' => 1],
        ['unit' => 'sack', 'label' => 'Sack (50kg)', 'multiplier_to_base' => 50, 'is_purchase_unit' => 1, 'is_sales_unit' => 1],
        ['unit' => 'pack', 'label' => 'Pack (5kg)', 'multiplier_to_base' => 5, 'is_purchase_unit' => 1, 'is_sales_unit' => 1],
    ]], $token);
    check('update Rice units (sack=50, pack=5)', $r['code'] === 200, json_encode($r));
}
check('Rice product id resolved', !empty($riceId), var_export($riceId, true));

function stockOf($token, $id) {
    $r = req('GET', '/products/' . $id, null, $token);
    return (float)($r['json']['stock_quantity'] ?? -1);
}

// ---- TEST 1: Restock 5 sacks = +250 kg ----
$before = stockOf($token, $riceId);
$r = req('POST', '/transactions/restock', ['supplier_name' => 'E2E Supplier',
    'items' => [['product_id' => $riceId, 'quantity' => 5, 'unit' => 'sack', 'unit_cost' => 2000]]], $token);
check('restock 5 sacks accepted', $r['code'] === 201 || $r['code'] === 200, "code={$r['code']} body=" . substr($r['raw'], 0, 300));
$after = stockOf($token, $riceId);
check('TEST1: restock 5 sacks adds +250 kg', abs(($after - $before) - 250) < 0.001, "before=$before after=$after");

// Verify history preserved original unit + conversion + base qty + per-sack cost
$r = req('GET', '/transactions?status=completed', null, $token);
$restockTx = null;
foreach (($r['json'] ?? []) as $t) { if (($t['transaction_type'] ?? '') === 'restock') { $restockTx = $t; break; } }
if ($restockTx) {
    $r2 = req('GET', '/transactions/' . $restockTx['id'], null, $token);
    $it = null;
    foreach (($r2['json']['items'] ?? []) as $i) { if ((int)$i['product_id'] === (int)$riceId) { $it = $i; break; } }
    if ($it) {
        check('history keeps 5 sack x50 = 250 kg', (float)$it['quantity'] === 5.0 && strtolower((string)$it['unit']) === 'sack'
            && (float)$it['conversion_rate'] === 50.0 && (float)$it['base_quantity'] === 250.0, json_encode($it));
        check('history cost is per-sack (2000 x 5 = 10000)', (float)$it['unit_price'] === 2000.0 && (float)$it['line_total'] === 10000.0, json_encode($it));
    } else check('restock item found in history', false, 'no matching item');
} else check('restock transaction found', false, 'none');

// ---- TEST 2: Sell 2 kg ----
$before = stockOf($token, $riceId);
$r = req('POST', '/transactions', ['customer_name' => 'E2E', 'payment_method' => 'cash',
    'items' => [['product_id' => $riceId, 'quantity' => 2, 'unit' => 'kg', 'unit_price' => 60]]], $token);
check('sale 2 kg accepted', $r['code'] === 201 || $r['code'] === 200, "code={$r['code']} body=" . substr($r['raw'], 0, 300));
$after = stockOf($token, $riceId);
check('TEST2: sell 2 kg deducts 2 (not 2 sacks)', abs(($before - $after) - 2) < 0.001, "before=$before after=$after");

// ---- TEST 3: Sell 1 sack = -50 kg ----
$before = stockOf($token, $riceId);
$r = req('POST', '/transactions', ['customer_name' => 'E2E', 'payment_method' => 'cash',
    'items' => [['product_id' => $riceId, 'quantity' => 1, 'unit' => 'sack', 'unit_price' => 2800]]], $token);
check('sale 1 sack accepted', $r['code'] === 201 || $r['code'] === 200, "code={$r['code']} body=" . substr($r['raw'], 0, 300));
$after = stockOf($token, $riceId);
check('TEST3: sell 1 sack deducts 50 kg', abs(($before - $after) - 50) < 0.001, "before=$before after=$after");

// ---- Pricing independence: client price honoured when unit has no configured price ----
$r = req('POST', '/transactions', ['customer_name' => 'E2E-price', 'payment_method' => 'cash',
    'items' => [['product_id' => $riceId, 'quantity' => 1, 'unit' => 'pack', 'unit_price' => 1]]], $token);
$txId = $r['json']['id'] ?? null;
$packPrice = null;
if ($txId) { $r2 = req('GET', '/transactions/' . $txId, null, $token); $packPrice = (float)($r2['json']['items'][0]['unit_price'] ?? 0); req('PATCH', '/transactions/' . $txId . '/void', null, $token); }
check('pricing independent of multiplier (pack=1 honoured)', $packPrice === 1.0, "packPrice=" . var_export($packPrice, true));

// ---- TEST 7: Insufficient stock rejection ----
$r = req('GET', '/products/' . $riceId, null, $token);
$cur = (float)$r['json']['stock_quantity'];
$need = (int)(floor($cur / 50) + 10);
$r = req('POST', '/transactions', ['customer_name' => 'E2E-fail', 'payment_method' => 'cash',
    'items' => [['product_id' => $riceId, 'quantity' => $need, 'unit' => 'sack', 'unit_price' => 2800]]], $token);
check('TEST7: oversized sale REJECTED (400)', $r['code'] === 400, "code={$r['code']} body=" . substr($r['raw'], 0, 200));
check('TEST7: detailed insufficient-stock message', strpos($r['raw'], 'Insufficient stock') !== false && strpos($r['raw'], 'Required:') !== false, substr($r['raw'], 0, 200));
$after = stockOf($token, $riceId);
check('TEST7: stock unchanged after rejection', abs($after - $cur) < 0.001, "cur=$cur after=$after");

// ---- TEST 8: Decimal sale 2.5 kg ----
$before = stockOf($token, $riceId);
$r = req('POST', '/transactions', ['customer_name' => 'E2E-dec', 'payment_method' => 'cash',
    'items' => [['product_id' => $riceId, 'quantity' => 2.5, 'unit' => 'kg', 'unit_price' => 60]]], $token);
check('decimal sale accepted', $r['code'] === 201 || $r['code'] === 200, "code={$r['code']} body=" . substr($r['raw'], 0, 300));
$after = stockOf($token, $riceId);
check('TEST8: sell 2.5 kg deducts 2.5', abs(($before - $after) - 2.5) < 0.001, "before=$before after=$after");

// ---- Whole-number enforcement: 1.5 sacks rejected ----
$r = req('POST', '/transactions', ['customer_name' => 'E2E-whole', 'payment_method' => 'cash',
    'items' => [['product_id' => $riceId, 'quantity' => 1.5, 'unit' => 'sack', 'unit_price' => 2800]]], $token);
check('sack sale of 1.5 rejected (whole number)', $r['code'] === 400 && strpos($r['raw'], 'whole number') !== false, "code={$r['code']} body=" . substr($r['raw'], 0, 200));

// ---- Unconfigured unit rejected (never trust client conversion) ----
$r = req('POST', '/transactions', ['customer_name' => 'E2E-badunit', 'payment_method' => 'cash',
    'items' => [['product_id' => $riceId, 'quantity' => 1, 'unit' => 'spaceship', 'unit_price' => 60]]], $token);
check('unconfigured unit rejected', $r['code'] === 400 && strpos($r['raw'], 'not a valid selling unit') !== false, "code={$r['code']} body=" . substr($r['raw'], 0, 200));

// ---- Purchase-unit flag enforced: kg is NOT a purchase unit for rice ----
$before = stockOf($token, $riceId);
$r = req('POST', '/transactions/restock', ['supplier_name' => 'E2E',
    'items' => [['product_id' => $riceId, 'quantity' => 100, 'unit' => 'kg', 'unit_cost' => 45]]], $token);
check('kg restock rejected when kg not a purchase unit', $r['code'] === 400, "code={$r['code']} body=" . substr($r['raw'], 0, 200));
$after = stockOf($token, $riceId);
check('stock unchanged after rejected restock', abs($after - $before) < 0.001, "before=$before after=$after");

echo "\n========================\nPASS: $PASS  FAIL: $FAIL\n";
exit($FAIL > 0 ? 1 : 0);

