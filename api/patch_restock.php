<?php
// Patcher for restock endpoint
$file = __DIR__ . '/index.php';
$content = file_get_contents($file);
$lines = explode("\n", $content);

// Find the restock POST endpoint
$restockStart = -1;
foreach ($lines as $i => $line) {
    if (strpos($line, "if (\$id === 'restock'") !== false) {
        $restockStart = $i;
        break;
    }
}

if ($restockStart >= 0) {
    // Find the end of this block - look for the next standalone '}' that ends the if block
    $braceCount = 0;
    $restockEnd = $restockStart;
    for ($i = $restockStart; $i < count($lines); $i++) {
        $braceCount += substr_count($lines[$i], '{');
        $braceCount -= substr_count($lines[$i], '}');
        if ($braceCount <= 0) {
            $restockEnd = $i;
            break;
        }
    }
    
    echo "Found restock endpoint from line " . ($restockStart + 1) . " to " . ($restockEnd + 1) . "\n";
    
    $newRestockCode = '        if ($id === \'restock\' && $method === \'POST\') {
            $requestItems = isset($body[\'items\']) && is_array($body[\'items\']) ? $body[\'items\'] : [[
                \'product_id\' => inputValue($body, \'product_id\'),
                \'quantity\' => inputValue($body, \'quantity\', 0),
                \'unit\' => inputValue($body, \'unit\', null),
                \'unit_cost\' => inputValue($body, \'unit_cost\'),
                \'retail_price\' => inputValue($body, \'retail_price\'),
            ]];
            if (!$requestItems || array_filter($requestItems, fn($item) => !inputValue($item, \'product_id\') || (float)inputValue($item, \'quantity\', 0) <= 0)) {
                respond([\'message\' => \'A valid product and quantity are required for every item\'], 400);
            }
            $pdo->beginTransaction();
            $supplier = trim((string)inputValue($body, \'supplier_name\', \'\')) ?: \'Supplier\';
            $restockItems = []; $total = 0;
            
            foreach ($requestItems as $item) {
                $productId = (int)inputValue($item, \'product_id\');
                $q = $pdo->prepare(\'SELECT id, name, base_unit, cost, price FROM products WHERE id=? FOR UPDATE\');
                $q->execute([$productId]);
                $product = $q->fetch();
                if (!$product) { $pdo->rollBack(); respond([\'message\' => \'Product not found\'], 404); }
                
                $quantity = (float)inputValue($item, \'quantity\', 0);
                $unit = inputValue($item, \'unit\', null);
                if (!$unit) {
                    $defaultUnit = getDefaultUnit($pdo, $productId);
                    $unit = $defaultUnit[\'unit\'] ?? $product[\'base_unit\'];
                }
                
                $units = getProductUnits($pdo, $productId);
                $conversionRate = 1;
                foreach ($units as $u) {
                    if ($u[\'unit\'] === $unit) {
                        $conversionRate = (float)$u[\'multiplier_to_base\'];
                        break;
                    }
                }
                
                $baseQuantity = round($quantity * $conversionRate, 4);
                
                $unitCost = inputValue($item, \'unit_cost\', null);
                $cost = ($unitCost === null || $unitCost === \'\') ? (float)$product[\'cost\'] : (float)$unitCost;
                if ($cost < 0) { $pdo->rollBack(); respond([\'message\' => \'Cost price must be zero or greater\'], 400); }
                $retail = inputValue($item, \'retail_price\', null);
                $retailPrice = ($retail === null || $retail === \'\') ? (float)$product[\'price\'] : (float)$retail;
                if ($retailPrice < 0) { $pdo->rollBack(); respond([\'message\' => \'Suggested Retail price must be zero or greater\'], 400); }
                
                $lineTotal = $quantity * $cost;
                $total += $lineTotal;
                $restockItems[] = [$product, $quantity, $unit, $conversionRate, $baseQuantity, $cost, $lineTotal, $retailPrice];
            }
            
            $invoice = \'INV-\'.date(\'YmdHis\').\'-\'.random_int(100,999);
            $q = $pdo->prepare("INSERT INTO transactions (invoice_no,user_id,customer_name,subtotal,discount,tax,total,payment_method,status,transaction_type,supplier_name) VALUES (?,?,?,?,0,0,?,\'other\',\'completed\',\'restock\',?)");
            $q->execute([$invoice,$user[\'id\'],$supplier,$total,$total,$supplier]);
            $txId = $pdo->lastInsertId();
            
            $itemQ = $pdo->prepare(\'INSERT INTO transaction_items (transaction_id,product_id,product_name,quantity,unit,conversion_rate,base_quantity,unit_price,line_total) VALUES (?,?,?,?,?,?,?,?,?)\');
            $stockQ = $pdo->prepare("UPDATE products SET stock_quantity=stock_quantity+?,price=?,cost=?,supplier_name=COALESCE(?,supplier_name),status=\'active\' WHERE id=?");
            
            foreach ($restockItems as [$product, $quantity, $unit, $conversionRate, $baseQuantity, $cost, $lineTotal, $retailPrice]) {
                $itemQ->execute([$txId, $product[\'id\'], $product[\'name\'], $quantity, $unit, $conversionRate, $baseQuantity, $cost, $lineTotal]);
                $stockQ->execute([$baseQuantity, $retailPrice, $cost, inputValue($body, \'supplier_name\'), $product[\'id\']]);
            }
            $pdo->commit();
            respond([\'id\'=>$txId,\'invoice_no\'=>$invoice,\'message\'=>\'Products restocked successfully\'],201);
        }';

    $newLines = explode("\n", $newRestockCode);
    array_splice($lines, $restockStart, $restockEnd - $restockStart + 1, $newLines);
    
    file_put_contents($file, implode("\n", $lines));
    echo "Successfully patched restock endpoint!\n";
} else {
    echo "Could not find restock endpoint.\n";
}

