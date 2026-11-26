<?php
// Simple patcher for VegieTrack API
$file = __DIR__ . '/index.php';
$content = file_get_contents($file);
$lines = explode("\n", $content);

// Find line 538 (0-indexed: 537)
$targetLine = 537;
if (isset($lines[$targetLine]) && strpos($lines[$targetLine], "if (\$method === 'POST')") !== false) {
    $newCode = '        if ($method === \'POST\') {
            if (empty($body[\'items\']) || !is_array($body[\'items\'])) respond([\'message\'=>\'At least one item is required\'],400);
            $pdo->beginTransaction();
            $subtotal = 0;
            $baseTotals = [];
            $processedItems = [];
            
            foreach($body[\'items\'] as $item) {
                $productId = (int)inputValue($item, \'product_id\', 0);
                if ($productId <= 0) {
                    $pdo->rollBack();
                    respond([\'message\'=>\'Invalid product_id\'], 400);
                }
                
                $product = $pdo->prepare(\'SELECT id, name, base_unit, stock_quantity, price FROM products WHERE id=? FOR UPDATE\');
                $product->execute([$productId]);
                $product = $product->fetch();
                if (!$product) {
                    $pdo->rollBack();
                    respond([\'message\'=>\'Product not found\'], 404);
                }
                
                $quantity = (float)inputValue($item, \'quantity\', 0);
                if ($quantity <= 0) {
                    $pdo->rollBack();
                    respond([\'message\'=>\'Quantity must be greater than 0\'], 400);
                }
                
                $unitPrice = (float)inputValue($item, \'unit_price\', $product[\'price\']);
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
                
                if (!isset($baseTotals[$productId])) {
                    $baseTotals[$productId] = 0;
                }
                $baseTotals[$productId] += $baseQuantity;
                
                $line = round($quantity * $unitPrice, 2);
                $subtotal += $line;
                
                $processedItems[] = [
                    \'product_id\' => $productId,
                    \'product_name\' => $item[\'product_name\'] ?? $product[\'name\'],
                    \'quantity\' => $quantity,
                    \'unit\' => $unit,
                    \'conversion_rate\' => $conversionRate,
                    \'base_quantity\' => $baseQuantity,
                    \'unit_price\' => $unitPrice,
                    \'line_total\' => $line
                ];
            }
            
            foreach ($baseTotals as $productId => $requiredBaseQty) {
                $product = $pdo->prepare(\'SELECT stock_quantity, base_unit, name FROM products WHERE id=?\');
                $product->execute([$productId]);
                $product = $product->fetch();
                if ((float)$product[\'stock_quantity\'] < $requiredBaseQty) {
                    $pdo->rollBack();
                    respond([\'message\' => "Insufficient stock."], 400);
                }
            }
            
            $discount = (float)inputValue($body, \'discount\', 0);
            $tax = (float)inputValue($body, \'tax\', 0);
            $invoice = \'INV-\' . date(\'YmdHis\') . \'-\' . random_int(100, 999);
            $total = round($subtotal - $discount + $tax, 2);
            
            $q = $pdo->prepare("INSERT INTO transactions (invoice_no, user_id, customer_name, subtotal, discount, tax, total, payment_method, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, \'completed\')");
            $q->execute([$invoice, $user[\'id\'], inputValue($body, \'customer_name\', \'Walk-in Customer\'), $subtotal, $discount, $tax, $total, inputValue($body, \'payment_method\', \'cash\')]);
            $txId = $pdo->lastInsertId();
            
            $itemQ = $pdo->prepare(\'INSERT INTO transaction_items (transaction_id, product_id, product_name, quantity, unit, conversion_rate, base_quantity, unit_price, line_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)\');
            $stockQ = $pdo->prepare("UPDATE products SET stock_quantity = GREATEST(stock_quantity - ?, 0), status = IF(stock_quantity - ? <= 0, \'inactive\', status) WHERE id = ?");
            
            foreach ($processedItems as $item) {
                $itemQ->execute([$txId, $item[\'product_id\'], $item[\'product_name\'], $item[\'quantity\'], $item[\'unit\'], $item[\'conversion_rate\'], $item[\'base_quantity\'], $item[\'unit_price\'], $item[\'line_total\']]);
                if (!empty($item[\'product_id\'])) {
                    $stockQ->execute([$item[\'base_quantity\'], $item[\'base_quantity\'], $item[\'product_id\']]);
                }
            }
            
            $pdo->commit();
            respond([\'id\'=>$txId, \'invoice_no\'=>$invoice, \'total\'=>$total, \'message\'=>\'Transaction recorded successfully\'], 201);
        }';

    // Split new code into lines and replace
    $newLines = explode("\n", $newCode);
    array_splice($lines, $targetLine, 1, $newLines);
    
    file_put_contents($file, implode("\n", $lines));
    echo "Successfully patched!\n";
} else {
    echo "Target line not found or already patched.\n";
    if (isset($lines[$targetLine])) {
        echo "Line content: " . substr($lines[$targetLine], 0, 100) . "...\n";
    }
}
