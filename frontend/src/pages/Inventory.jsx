import { useEffect, useState, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Plus, Pencil, Trash2, X, Search, FileDown, QrCode, ScanLine, ChevronLeft, ChevronRight, ImagePlus, Truck, Package, AlertTriangle } from 'lucide-react';
import QRCode from 'qrcode';
import { Html5Qrcode } from 'html5-qrcode';
import api from '../api/axios';
import { exportTableToPDF } from '../utils/pdfExport';
import { formatCurrency as formatCurrencyWithSymbol, formatCurrencyForPDF } from '../utils/currency';
import { useSettings } from '../context/SettingsContext';
import { useAuth } from '../context/AuthContext';

const emptyForm = { sku: '', name: '', category_id: '', base_unit: 'kg', price: '', price_auto: true, costPrice: '', stock_quantity: '', supplier_name: '', low_stock_threshold: 10, status: 'active', image_url: '', units: [{ unit: 'kg', label: 'Kilogram', multiplier_to_base: 1, price: null, price_auto: true, is_purchase_unit: 1, is_sales_unit: 1 }] };

const UNIT_OPTIONS = ['kg', 'g', 'pcs', 'piece', 'bundle', 'pack', 'box', 'sack', 'tray', 'bottle', 'can', 'liter', 'ton'];

const resolveProductImage = (imageUrl) =>
  typeof imageUrl === 'string' && imageUrl.startsWith('/images/products/')
    ? `${import.meta.env.BASE_URL}${imageUrl.slice(1)}`
    : imageUrl;

// Cost per base unit (kg) = Cost Price (total) divided by total base kg
// e.g. 1 pack = 10 kg, qty 1, cost 1000 -> 1000 / (1 * 10) = 100 per kg
const computeCostPerKg = (costPrice, quantity, multiplier = 1) => {
  if (costPrice === '' || costPrice === null || costPrice === undefined) return null;
  if (quantity === '' || quantity === null || quantity === undefined) return null;
  const cost = Number(costPrice);
  const qty = Number(quantity);
  const mult = Number(multiplier);
  const safeMult = Number.isFinite(mult) && mult > 0 ? mult : 1;
  if (!Number.isFinite(cost) || cost < 0 || !Number.isFinite(qty) || qty <= 0) return null;
  return cost / (qty * safeMult);
};

// Money is stored with 2 decimals, so converted prices are rounded the same way.
const roundMoney = (val) => Math.round(Number(val) * 100) / 100;

// Unit Price (per unit) = Suggested Retail Price per base unit × multiplier_to_base
// e.g. retail ₱85.00/kg and a pack of 0.5 kg → ₱42.50 per pack
const computeUnitPrice = (retailPrice, multiplier) => {
  if (retailPrice === '' || retailPrice === null || retailPrice === undefined) return null;
  if (multiplier === '' || multiplier === null || multiplier === undefined) return null;
  const price = Number(retailPrice);
  const mult = Number(multiplier);
  if (!Number.isFinite(price) || price < 0 || !Number.isFinite(mult) || mult <= 0) return null;
  return roundMoney(price * mult);
};

// A unit price is auto-converted from the suggested retail price unless the admin typed an override.
const isAutoUnitPrice = (unitItem) => unitItem.price_auto !== false;

// Auto-calculate the suggested retail price per base unit as a 20% markup on cost.
// cost per base unit = costPrice / (stock_quantity * multiplier)  →  retail = cost * 1.20
const computeAutoPrice = (costPrice, stockQuantity, multiplier = 1) => {
  const costPerBase = computeCostPerKg(costPrice, stockQuantity, multiplier);
  if (costPerBase === null) return null;
  return roundMoney(costPerBase * 1.2);
};

// Friendly labels used when a product has no units configured yet.
const UNIT_LABELS = { kg: 'Kilogram', g: 'Gram', pcs: 'Pieces', piece: 'Piece', ton: 'Tonne', liter: 'Liter' };

// A unit multiplier must be a positive number. A blank or invalid entry
// (the user is mid-typing, e.g. clearing "1" before typing "40") falls back
// to 1 so price/stock math and the saved payload stay valid.
const normalizeMultiplier = (val) => {
  const num = Number(val);
  return Number.isFinite(num) && num > 0 ? num : 1;
};

// Display stock without trailing ".00" (e.g. 10.00 -> 10, 10.50 -> 10.5)
const formatStock = (val) => {
  if (val === '' || val === null || val === undefined) return '-';
  const num = Number(val);
  if (!Number.isFinite(num)) return val;
  return String(parseFloat(num.toFixed(2)));
};

// Edit-form inputs show numbers with at most 2 decimals and no trailing
// zeros (e.g. "498.0000" -> "498", "10.2500" -> "10.25") so fields opened
// for editing don't display padded database decimals like 10.0000.
// Unlike formatStock this returns '' (not '-') for empty values, since it
// is used as the value of <input> fields.
const formatFormNumber = (val) => {
  if (val === '' || val === null || val === undefined) return '';
  const num = Number(val);
  if (!Number.isFinite(num)) return String(val);
  return String(parseFloat(num.toFixed(2)));
};

// Show stock in the largest configured sales unit for readability (e.g. 498 kg ≈ 9 sack)
const formatEquivalent = (p) => {
  const units = (p.units || []).filter((u) => u.is_sales_unit !== 0 && Number(u.multiplier_to_base) > 1);
  if (!units.length) return null;
  const best = units.reduce((a, b) => (Number(b.multiplier_to_base) > Number(a.multiplier_to_base) ? b : a));
  const eq = Number(p.stock_quantity) / Number(best.multiplier_to_base);
  if (!Number.isFinite(eq) || eq < 1) return null;
  return '≈ ' + formatStock(Math.floor(eq)) + ' ' + best.unit;
};

export default function Inventory() {
  const { settings } = useSettings();
  const { user } = useAuth();
  const isDemo = Boolean(user?.demo_mode);
  const location = useLocation();
  const navigate = useNavigate();
  const showSpoiledProductPicker = !isDemo && Boolean(location.state?.openSpoiledModal);
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [stockFilter, setStockFilter] = useState('all');
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);

  // Changing a unit's multiplier (or the unit itself) re-derives its suggested retail
  // price so the converted price always follows the base-unit suggested retail price.
  const handleUnitChange = (index, field, value) => {
    setForm((prev) => {
      const newUnits = prev.units.map((u, i) => (i === index ? { ...u, [field]: value } : u));
      const target = newUnits[index];
      if (isAutoUnitPrice(target) && (field === 'multiplier_to_base' || field === 'unit')) {
        const multiplier = field === 'multiplier_to_base' ? value : target.multiplier_to_base;
        newUnits[index] = { ...target, price: computeUnitPrice(prev.price, multiplier) };
      }
      return { ...prev, units: newUnits };
    });
  };

  // Typing a suggested retail price per base unit re-converts every auto unit price.
  // The user is now overriding the auto-derived price, so flip price_auto off.
  const handleRetailPriceChange = (value) => {
    setForm((prev) => ({
      ...prev,
      price: value,
      price_auto: false,
      units: prev.units.map((u) => (isAutoUnitPrice(u) ? { ...u, price: computeUnitPrice(value, u.multiplier_to_base) } : u)),
    }));
  };
  
  // When cost price changes, re-derive the suggested retail price (20% markup) — but only
  // if the user hasn't manually overridden the suggested retail price (price_auto is still true).
  // Stock quantity also affects the per-base-unit cost, so this is called from both
  // the Cost Price and Stock Quantity handlers.
  const recalculateAutoPrice = (prev) => {
    if (!prev.price_auto) return prev;
    const autoPrice = computeAutoPrice(prev.costPrice, prev.stock_quantity);
    if (autoPrice === null) return prev;
    return {
      ...prev,
      price: String(autoPrice),
      units: prev.units.map((u) =>
        isAutoUnitPrice(u) ? { ...u, price: computeUnitPrice(autoPrice, u.multiplier_to_base) } : u
      ),
    };
  };

  const handleCostPriceChange = (value) => {
    setForm((prev) => recalculateAutoPrice({ ...prev, costPrice: value }));
  };

  const handleStockQuantityChange = (value) => {
    setForm((prev) => recalculateAutoPrice({ ...prev, stock_quantity: value }));
  };

  const resetPriceToAuto = () => {
    setForm((prev) => {
      const autoPrice = computeAutoPrice(prev.costPrice, prev.stock_quantity);
      if (autoPrice === null) return prev;
      return {
        ...prev,
        price: String(autoPrice),
        price_auto: true,
        units: prev.units.map((u) =>
          isAutoUnitPrice(u) ? { ...u, price: computeUnitPrice(autoPrice, u.multiplier_to_base) } : u
        ),
      };
    });
  };

  // Manual override: the typed unit price is kept until it is reset to auto.
  const handleUnitPriceChange = (index, value) => {
    setForm((prev) => ({
      ...prev,
      units: prev.units.map((u, i) => {
        if (i !== index) return u;
        const derived = computeUnitPrice(prev.price, u.multiplier_to_base);
        return {
          ...u,
          price: value === '' ? null : value,
          price_auto: value === '' || (derived !== null && roundMoney(value) === derived),
        };
      }),
    }));
  };

  const resetUnitPriceToAuto = (index) => {
    setForm((prev) => ({
      ...prev,
      units: prev.units.map((u, i) => (i === index ? { ...u, price: computeUnitPrice(prev.price, u.multiplier_to_base), price_auto: true } : u)),
    }));
  };

  const addUnit = () => {
    setForm((prev) => ({
      ...prev,
      units: [...prev.units, { unit: 'kg', label: '', multiplier_to_base: 1, price: computeUnitPrice(prev.price, 1), price_auto: true, is_purchase_unit: 1, is_sales_unit: 1 }]
    }));
  };

  const removeUnit = (index) => {
    const newUnits = form.units.filter((_, i) => i !== index);
    setForm({ ...form, units: newUnits });
  };

  const [error, setError] = useState('');
  const [qrProduct, setQrProduct] = useState(null);
  const [qrImage, setQrImage] = useState('');
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scannedProduct, setScannedProduct] = useState(null);
  const [page, setPage] = useState(1);
  const [imagePreview, setImagePreview] = useState('');
  // True when the live DB still has the legacy VARCHAR(255) image_url column
  // that rejects EVERY photo. Shown as a one-click "Fix database" banner.
  const [dbNeedsMigration, setDbNeedsMigration] = useState(false);
  const [migrating, setMigrating] = useState(false);
  // File chosen in the modal but NOT yet uploaded. It is uploaded only
  // when the user clicks Save Changes / Add Product, so Cancel never
  // leaves an orphan file in the upload folder.
  const [pendingImageFile, setPendingImageFile] = useState(null);
  const pendingPreviewUrlRef = useRef('');
  const [uploading, setUploading] = useState(false);
  const [showRestockModal, setShowRestockModal] = useState(false);
  const [restockItems, setRestockItems] = useState([{}]);
  const [restockSupplier, setRestockSupplier] = useState('');
  const [batchProduct, setBatchProduct] = useState(null);
  const [batches, setBatches] = useState([]);
  const [batchesLoading, setBatchesLoading] = useState(false);
  const [batchError, setBatchError] = useState('');
  const [batchTab, setBatchTab] = useState('new');
  // Spoiled product (stock write-off) modal state. These hooks MUST live
  // inside the component — an earlier version declared them at module
  // top-level, which made React throw "Cannot read properties of null
  // (reading 'useState')" and white-screened the whole app.
  const [showSpoiledModal, setShowSpoiledModal] = useState(false);
  const [spoiledProduct, setSpoiledProduct] = useState({ product_id: '', batch_id: '', quantity: '', reason: '' });
  const [spoiledAvailableStock, setSpoiledAvailableStock] = useState(0);
  const [spoiledBatches, setSpoiledBatches] = useState([]);
  const [spoiledProductName, setSpoiledProductName] = useState('');
  const [spoiledUnit, setSpoiledUnit] = useState('');
  const [spoiledSubmitting, setSpoiledSubmitting] = useState(false);
  const [spoiledError, setSpoiledError] = useState('');
  const [spoiledBatchWarning, setSpoiledBatchWarning] = useState('');
  const openedNotificationProductRef = useRef(null);
  const fileInputRef = useRef(null);
  const PAGE_SIZE = 10;
  const clearPendingImage = () => {
    // Revoke the local object-URL preview (no server file exists yet).
    if (pendingPreviewUrlRef.current) {
      URL.revokeObjectURL(pendingPreviewUrlRef.current);
      pendingPreviewUrlRef.current = '';
    }
    setPendingImageFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleCloseModal = () => {
    // The pending image was never uploaded to the server, so cancelling
    // leaves no orphan file in the upload folder.
    clearPendingImage();
    setImagePreview('');
    setShowModal(false);
  };

  // Drop pending-file preview URL on unmount to avoid leaking object URLs.
  useEffect(() => () => {
    if (pendingPreviewUrlRef.current) URL.revokeObjectURL(pendingPreviewUrlRef.current);
  }, []);

  useEffect(() => {
    if (!scannerOpen) return undefined;
    const scanner = new Html5Qrcode('vegietrack-qr-reader');
    let stopped = false;
    scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 240, height: 240 } },
      (decodedText) => {
        try {
          const decoded = JSON.parse(decodedText);
          const match = products.find((product) => String(product.id) === String(decoded.id) || product.sku === decoded.sku);
          if (match) {
            setScannedProduct(match);
            setScannerOpen(false);
          } else {
            setError('The QR code does not match a product in this inventory.');
          }
        } catch {
          const match = products.find((product) => product.sku === decodedText);
          if (match) {
            setScannedProduct(match);
            setScannerOpen(false);
          } else {
            setError('The scanned QR code is not a VegieTrack product code.');
          }
        }
      },
      () => {}
    ).catch(() => setError('Unable to access the camera. Please allow camera access and try again.'));
    return () => {
      if (!stopped) {
        stopped = true;
        scanner.stop().catch(() => {});
      }
    };

  }, [scannerOpen, products]);

  const generateQr = async (product) => {
    const image = await QRCode.toDataURL(JSON.stringify({ type: 'VegieTrack product', id: product.id, sku: product.sku }));
    setQrProduct(product);
    setQrImage(image);
  };

  const loadData = async () => {
    setLoading(true);
    try {
      const [prodRes, catRes, dbRes] = await Promise.all([
        api.get('/products'),
        api.get('/products/categories'),
        // Reports whether the live DB still has the legacy VARCHAR(255)
        // image_url column that rejects every photo (old installs).
        api.get('/health/db').catch(() => null),
      ]);
      setProducts(prodRes.data);
      setCategories(catRes.data);
      const col = dbRes?.data?.image_url_column;
      if (col && col.character_maximum_length === 255) {
        setDbNeedsMigration(true);
      } else {
        setDbNeedsMigration(false);
      }
    } catch (err) {
      if (err.isAuthError) return;
      setDbNeedsMigration(false);
      setError('Failed to load inventory data');
    } finally {
      setLoading(false);
    }
  };

  // One-click fix for "Image is too large for the database": asks the API
  // (admin-only) to widen products.image_url to TEXT/MEDIUMTEXT.
  const runImageColumnMigration = async () => {
    setMigrating(true);
    setError('');
    try {
      const res = await api.post('/health/migrate-image-url');
      setDbNeedsMigration(false);
      setError('');
      alert(res.data.message || 'Database fixed — you can now save product photos.');
    } catch (err) {
      setDbNeedsMigration(false);
      setError(err.response?.data?.message || 'Database migration failed. Run the SQL manually in Supabase.');
    } finally {
      setMigrating(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  const openAddModal = () => {
    setForm(emptyForm);
    setEditingId(null);
    setError('');
    clearPendingImage();
    setImagePreview('');
    setShowModal(true);
  };

    const openEditModal = (product) => {
    setForm({
      sku: product.sku || '',
      name: product.name,
      category_id: product.category_id || '',
      base_unit: product.base_unit || 'kg',
      price: product.price === null || product.price === undefined ? '' : formatFormNumber(product.price),
      // Auto price is active when the stored suggested retail price matches a 20% markup on cost per base unit.
      price_auto: product.cost !== null && product.cost !== undefined
        && product.price !== null && product.price !== undefined
        && roundMoney(Number(product.price)) === roundMoney(Number(product.cost) * 1.2),
      costPrice: product.cost !== null && product.cost !== undefined && Number(product.cost) >= 0 && Number(product.stock_quantity) > 0 ? formatFormNumber(Number(product.cost) * Number(product.stock_quantity)) : '',
      stock_quantity: formatFormNumber(product.stock_quantity),
      unit: product.base_unit || 'kg',
      supplier_name: product.supplier_name || '',
      low_stock_threshold: formatFormNumber(product.low_stock_threshold),
      status: product.status,
      image_url: product.image_url || '',
      units: (product.units && product.units.length > 0 ? product.units : [{
        unit: product.base_unit || 'kg',
        label: UNIT_LABELS[product.base_unit] || product.base_unit || 'Kilogram',
        multiplier_to_base: 1,
        price: null,
        is_purchase_unit: 1,
        is_sales_unit: 1,
      }]).map((u) => {
        // Number() strips padded zeros from database decimals ("0.5000" -> 0.5,
        // "1.0000" -> 1) without rounding, so small multipliers like 0.001 stay exact.
        const multiplier = u.multiplier_to_base !== null && u.multiplier_to_base !== undefined ? Number(u.multiplier_to_base) : 1;
        const derived = computeUnitPrice(product.price, multiplier);
        const stored = u.price === null || u.price === undefined || u.price === '' ? null : Number(u.price);
        return {
          unit: u.unit,
          label: u.label || u.unit,
          multiplier_to_base: multiplier,
          // Prices are converted automatically from the base-unit suggested retail price;
          // a stored price that differs is a manual override and is kept.
          price: stored === null ? derived : stored,
          price_auto: stored === null || (derived !== null && roundMoney(stored) === derived),
          is_purchase_unit: u.is_purchase_unit !== 0 ? 1 : 0,
          is_sales_unit: u.is_sales_unit !== 0 ? 1 : 0,
        };
      }),
    });
    setEditingId(product.id);
    setError('');
    clearPendingImage();
    setImagePreview(product.image_url || '');
    setShowModal(true);
  };

  const handleImageUpload = (file) => {
    if (!file) return;
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.type)) {
      setError('Only JPEG, PNG, and WebP images are allowed');
      return;
    }
    // Stage the file locally only — do NOT upload yet. The actual upload
    // happens inside handleSubmit, so pressing Cancel never touches the
    // server and leaves no orphan file in the upload folder.
    // Note: no hard size check here — handleSubmit compresses the image down
    // to ~1600px / JPEG 0.82 first, so a large phone photo still works.
    if (pendingPreviewUrlRef.current) URL.revokeObjectURL(pendingPreviewUrlRef.current);
    pendingPreviewUrlRef.current = URL.createObjectURL(file);
    setPendingImageFile(file);
    setImagePreview(pendingPreviewUrlRef.current);
    setError('');
    // Reset the input so the same file can be picked again if removed.
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleRemoveImage = () => {
    // Pending file was never uploaded, so there is nothing to delete server-side.
    clearPendingImage();
    setForm((prev) => ({ ...prev, image_url: '' }));
    setImagePreview('');
  };

  const handleImageDrop = (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleImageUpload(file);
  };

// Downscale/compress a staged image in the browser before upload so even a
// large phone photo becomes a few hundred KB. This keeps both the multipart
// upload and the later PUT /products/:id JSON body well under Vercel's ~4.5 MB
// limit, and avoids products.image_url overflows (the old VARCHAR(255) /
 // uncompressed 5 MB path is what produced `PUT ... 500`).
const compressImageFile = (file) =>
  new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const MAX_DIM = 1600;
      const scale = Math.min(1, MAX_DIM / Math.max(img.width || 1, img.height || 1));
      const w = Math.max(1, Math.round((img.width || 1) * scale));
      const h = Math.max(1, Math.round((img.height || 1) * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      // JPEG has no alpha — paint a white background so PNG transparency
      // does not turn black after conversion.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob(
        (blob) => resolve(blob || file),
        'image/jpeg',
        0.82,
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(file); // fall back to the original file on decode failure
    };
    img.src = url;
  });

    const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    const units = (form.units || []).map((u) => ({
      unit: u.unit,
      label: u.label || u.unit,
      multiplier_to_base: normalizeMultiplier(u.multiplier_to_base),
      price: u.price === null || u.price === '' || u.price === undefined ? null : Number(u.price),
      is_purchase_unit: u.is_purchase_unit !== 0 ? 1 : 0,
      is_sales_unit: u.is_sales_unit !== 0 ? 1 : 0,
    }));

    // Upload the staged image (if any) ONLY now that the user clicked Save.
    // If the user had pressed Cancel, this code never runs, so no file is
    // left behind in the upload folder.
    let imageUrl = form.image_url;
    if (pendingImageFile) {
      setUploading(true);
      try {
        // Compress first: a raw phone photo can be 5+ MB, which base64-expands
        // past hosting JSON body limits and trips PUT /products/:id 500.
        const compressed = await compressImageFile(pendingImageFile);
        if (compressed.size > 2 * 1024 * 1024) {
          setError('That photo is still larger than 2 MB after compression. Please use a smaller photo.');
          setUploading(false);
          return;
        }
        const formData = new FormData();
        formData.append('image', compressed, 'product.jpg');
        const res = await api.post('/upload/product-image', formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
        imageUrl = res.data.image_url;
    } catch (err) {
        setError(err.response?.data?.message || 'Failed to upload image');
        setUploading(false);
        return;
      }
      setUploading(false);
    }

    const payload = {
      sku: form.sku,
      name: form.name,
      category_id: form.category_id,
      base_unit: form.base_unit || 'kg',
      price: form.price,
      costPrice: form.costPrice === '' ? null : Number(form.costPrice),
      stock_quantity: editingId ? undefined : (form.stock_quantity === '' ? 0 : Number(form.stock_quantity)),
      unit: form.base_unit || 'kg',
      supplier_name: form.supplier_name || null,
      low_stock_threshold: form.low_stock_threshold,
      status: form.status,
      image_url: imageUrl,
      units: units,
    };
    if (editingId) payload.id = editingId;
    const requiredFields = [
      ['sku', 'SKU'],
      ['name', 'Product name'],
      ['category_id', 'Category'],
      ['price', 'Suggested Retail price (per base unit)'],
    ];
    const missingField = requiredFields.find(([field]) => !String(payload[field] ?? '').trim());
    if (missingField) {
      setError(`${missingField[1]} is required`);
      return;
    }
    try {
      if (editingId) {
        await api.put(`/products/${editingId}`, payload);
      } else {
        await api.post('/products', payload);
      }
      clearPendingImage();
      setImagePreview('');
      setShowModal(false);
      window.dispatchEvent(new CustomEvent('stockUpdated'));
      loadData();
    } catch (err) {
      // Product save failed: remove the just-uploaded image so a failed
      // save does not leave an orphan file either.
      if (pendingImageFile && imageUrl && imageUrl !== form.image_url) {
        api.delete('/upload/product-image', { data: { image_url: imageUrl } }).catch(() => {});
      }
      // If the live DB still has the legacy VARCHAR(255) column, flag it so
      // the one-click "Fix database" banner appears immediately.
      // Never surface a stale banner: a non-image error must clear it.
      const msg = err.response?.data?.message || 'Failed to save product';
      setDbNeedsMigration(/too large for the database/i.test(msg));
      setError(msg);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this product? This cannot be undone.')) return;
    try {
      await api.delete(`/products/${id}`);
      loadData();
    } catch (err) {
      alert(err.response?.data?.message || 'Failed to delete product');
    }
  };

  const openRestockModal = () => {
    setError('');
    setRestockItems([{}]);
    setRestockSupplier('');
    setShowRestockModal(true);
  };

  const openBatchModal = async (product) => {
    setBatchProduct(product);
    setBatches([]);
    setBatchError('');
    setBatchTab('new');
    setBatchesLoading(true);
    try {
      const res = await api.get(`/products/${product.id}/batches`);
      setBatches(res.data || []);
    } catch (err) {
      setBatchError(err.response?.data?.message || 'Failed to load batches');
    } finally {
      setBatchesLoading(false);
    }
  };

  // Open the "Mark as Spoiled" modal for a product. Loads the product's FIFO
  // batches so the user can pick which purchase batch the spoiled stock came
  // from (oldest first), and seeds the available stock from the product row.
  const openSpoiledProductModal = async (product) => {
    setSpoiledError('');
    setSpoiledBatchWarning('');
    setSpoiledProduct({ product_id: product.id, batch_id: '', quantity: '', reason: '' });
    setSpoiledAvailableStock(Number(product.stock_quantity) || 0);
    setSpoiledProductName(product.name || '');
    setSpoiledUnit(product.base_unit || 'kg');
    setSpoiledBatches([]);
    setShowSpoiledModal(true);
    try {
      const res = await api.get(`/products/${product.id}/batches`);
      const list = Array.isArray(res.data) ? res.data : [];
      setSpoiledBatches(list);
      // Default to the oldest batch with remaining stock (FIFO).
      const oldest = list.find((b) => Number(b.quantity) > 0);
      if (oldest) {
        setSpoiledProduct((prev) => ({ ...prev, batch_id: String(oldest.id) }));
      }
    } catch {
      // Batches are optional for the write-off — the backend can still record
      // the spoilage against the product's aggregate stock.
      setSpoiledBatches([]);
      setSpoiledBatchWarning('Batch details could not be loaded. The write-off will use overall stock and the product cost price.');
    }
  };

  const closeSpoiledModal = () => {
    if (spoiledSubmitting) return;
    setShowSpoiledModal(false);
    setSpoiledError('');
  };

  const handleSpoiledSubmit = async () => {
    const { product_id, batch_id, quantity, reason } = spoiledProduct;
    const qty = Number(quantity);
    if (!product_id) {
      setSpoiledError('Please select a product.');
      return;
    }
    if (!quantity || !Number.isFinite(qty) || qty <= 0) {
      setSpoiledError('Enter a quantity greater than 0.');
      return;
    }
    if (qty > spoiledAvailableStock) {
      setSpoiledError(`Only ${formatStock(spoiledAvailableStock)} in stock available.`);
      return;
    }
    const selectedBatch = spoiledBatches.find((batch) => String(batch.id) === String(batch_id));
    if (selectedBatch && qty > Number(selectedBatch.quantity)) {
      setSpoiledError(`Only ${formatStock(selectedBatch.quantity)} ${spoiledUnit} available in this batch.`);
      return;
    }

    setSpoiledSubmitting(true);
    setSpoiledError('');
    try {
      await api.post('/spoiled-products', {
        product_id: Number(product_id),
        batch_id: batch_id ? Number(batch_id) : null,
        quantity: qty,
        reason: reason || '',
      });
      setShowSpoiledModal(false);
      setSpoiledProduct({ product_id: '', batch_id: '', quantity: '', reason: '' });
      // Refresh inventory so stock columns reflect the write-off.
      loadData();
      window.dispatchEvent(new CustomEvent('stockUpdated'));
    } catch (err) {
      setSpoiledError(err.response?.data?.message || 'Failed to record spoiled product');
    } finally {
      setSpoiledSubmitting(false);
    }
  };

  // Open modals/scanner when navigated from Dashboard shortcut buttons
  useEffect(() => {
    const state = location.state;
    if (!state) return;
    if (state.openAddProduct) {
      openAddModal();
    }
    if (state.openRestock) {
      openRestockModal();
    }
    if (state.openScanner) {
      setError('');
      setScannerOpen(true);
    }
    if (state.openBatches && state.product) {
      openBatchModal(state.product);
    }
  }, []);

  useEffect(() => {
    const productId = location.state?.notificationProductId;
    if (!productId || !products.length || String(openedNotificationProductRef.current) === String(productId)) return;
    const product = products.find((item) => String(item.id) === String(productId));
    if (!product) return;
    openedNotificationProductRef.current = productId;
    setSearch(product.name);
    openBatchModal(product);
  }, [location.state?.notificationProductId, products]);

  const updateRestockItem = (index, field, value) => {
        setRestockItems((items) => items.map((item, itemIndex) => {
          if (itemIndex !== index) return item;
          if (field === 'product_id') {
            const product = products.find((candidate) => String(candidate.id) === value);
            const purchaseUnit = (product?.units || []).find((u) => u.is_purchase_unit !== 0);
            const unit_id = purchaseUnit ? String(purchaseUnit.id) : '';
            const multiplier = purchaseUnit && (purchaseUnit.multiplier_to_base !== null && purchaseUnit.multiplier_to_base !== undefined)
              ? Number(purchaseUnit.multiplier_to_base)
              : (product && product.units ? Number(product.units.find(u => u.is_purchase_unit !== 0)?.multiplier_to_base ?? 1) || 1 : 1);
            return { ...item, product_id: value, unit_id, unit_multiplier: multiplier, costPerKg: null };
          }
          if (field === 'unit_id') {
            const product = products.find((candidate) => String(candidate.id) === item.product_id);
            const matched = (product?.units || []).find((u) => String(u.id) === String(value));
            const multiplier = matched && (matched.multiplier_to_base !== null && matched.multiplier_to_base !== undefined)
              ? Number(matched.multiplier_to_base)
              : (value === (product?.base_unit || '') ? 1 : 1);
            return { ...item, unit_id: value, unit_multiplier: multiplier, costPerKg: null };
          }
          return { ...item, [field]: value };
        }));
  };

  const handleRestock = async (e) => {
    e.preventDefault();
    setError('');
    const validItems = restockItems.map((item) => ({
      ...item,
      quantity: Number(item.quantity),
      cost: item.cost === '' || item.cost === null || item.cost === undefined ? null : Number(item.cost),
    }));
    const invalidIndex = validItems.findIndex((item) => !item.product_id || item.quantity <= 0);
    if (invalidIndex !== -1) {
      setError(`Restock row ${invalidIndex + 1}: select a product and enter a quantity greater than zero`);
      return;
    }
    const invalidCostIndex = validItems.findIndex((item) => item.cost !== null && (!Number.isFinite(item.cost) || item.cost < 0));
    if (invalidCostIndex !== -1) {
      setError(`Restock row ${invalidCostIndex + 1}: cost price must be zero or greater`);
      return;
    }
    if (new Set(validItems.map((item) => String(item.product_id))).size !== validItems.length) {
      setError('Each product can only be added once per restock');
      return;
    }
    try {
      await api.post('/transactions/restock', {
        items: validItems.map((item) => {
          const product = products.find((candidate) => String(candidate.id) === String(item.product_id));
          const payloadItem = {
            product_id: item.product_id,
            quantity: item.quantity,
            unit: (() => { const u = (product?.units || []).find((un) => String(un.id) === String(item.unit_id)); return u?.unit || product?.base_unit || ''; })(),
            unit_id: item.unit_id || null,
            unit_cost: Number(product?.cost) || 0,
          };
          if (item.cost !== null) {
            payloadItem.total_cost = item.cost;
            payloadItem.unit_cost = item.cost / item.quantity; // Cost per Kilogram = Cost Price / Kilogram
          }
          return payloadItem;
        }),
        supplier_name: restockSupplier.trim(),
      });
      setShowRestockModal(false);
      setRestockItems([{}]);
      setRestockSupplier('');
      window.dispatchEvent(new CustomEvent('stockUpdated'));
      loadData();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to restock product');
    }
  };

  const filtered = products.filter((p) => {
    const matchesSearch = p.name.toLowerCase().includes(search.toLowerCase()) || (p.sku || '').toLowerCase().includes(search.toLowerCase());
    const matchesCategory = !categoryFilter || String(p.category_id) === String(categoryFilter);
    const stock = Number(p.stock_quantity);
    const matchesStock = stockFilter === 'all'
      || (stockFilter === 'out' && stock <= 0)
      || (stockFilter === 'low' && stock > 0 && stock <= Number(p.low_stock_threshold))
      || (stockFilter === 'in' && stock > Number(p.low_stock_threshold));
    return matchesSearch && matchesCategory && matchesStock;
  }).sort((a, b) => Number(a.stock_quantity) - Number(b.stock_quantity));

  useEffect(() => {
    setPage(1);
  }, [search, categoryFilter, stockFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const formatCurrency = (val) => formatCurrencyWithSymbol(val, settings?.currency);
  const selectedSpoiledBatch = spoiledBatches.find((batch) => String(batch.id) === String(spoiledProduct.batch_id));
  const selectedSpoiledProduct = products.find((product) => String(product.id) === String(spoiledProduct.product_id));
  const spoiledCostPrice = selectedSpoiledBatch?.cost_per_base ?? selectedSpoiledProduct?.cost ?? 0;
  const spoiledLossPreview = (Number(spoiledProduct.quantity) || 0) * (Number(spoiledCostPrice) || 0);

    // Converted suggested retail price per configured selling unit, e.g. "₱42.50/pack".
  // When a unit has a manual price override (u.price), that value is shown so
  // that same-name units with different multipliers/prices are distinguishable.
  const unitPriceBreakdown = (p) => {
    const price = Number(p.price);
    if (!Number.isFinite(price) || price <= 0) return null;
    const units = (p.units || []).filter((u) => u.is_sales_unit !== 0 && Number(u.multiplier_to_base) > 0 && Number(u.multiplier_to_base) !== 1);
    if (!units.length) return null;
    // When multiple units share the same name (now allowed), include the
    // multiplier so each entry is distinguishable in the breakdown.
    const names = units.map((u) => u.unit);
    const hasDupes = names.some((n, i) => names.indexOf(n) !== i);
    const shown = units.slice(0, 3).map((u) => {
      const unitPrice = (u.price === null || u.price === undefined || u.price === '')
        ? computeUnitPrice(price, u.multiplier_to_base)
        : Number(u.price);
      const label = u.label || u.unit;
      return `${formatCurrency(unitPrice)}/${hasDupes ? `${label} (${u.multiplier_to_base || 1})` : label}`;
    }).join(' · ');
    return units.length > 3 ? `${shown} +${units.length - 3}` : shown;
  };

  const handleExportPDF = () => {
    const columns = ['SKU', 'Name', 'Category', 'Stock', 'Base Unit', 'Cost (per base unit)', 'Suggested Retail Price (per base unit)', 'Stock Value'];
    const rows = filtered.map((p) => [
      p.sku || '-',
      p.name,
      p.category_name || '-',
      formatStock(p.stock_quantity),
      p.base_unit,
      formatCurrencyForPDF(p.cost, settings?.currency),
      formatCurrencyForPDF(p.price, settings?.currency),
      formatCurrencyForPDF(Number(p.stock_quantity) * Number(p.price), settings?.currency),
    ]);
    const totalStockValue = filtered.reduce((sum, p) => sum + Number(p.stock_quantity) * Number(p.price || 0), 0);
    exportTableToPDF('Inventory Report', columns, rows, 'inventory-report', `${filtered.length} product(s) | Total Stock Value: ${formatCurrencyForPDF(totalStockValue, settings?.currency)}`, settings);
  };

  return (
    <div className="space-y-6 min-w-0">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-800">Inventory</h1>
          <p className="text-gray-500 text-xs sm:text-sm">Manage vegetable products and stock levels</p>
        </div>
        <div className="flex flex-wrap gap-2 w-full sm:w-auto">
          <button
            onClick={() => { setError(''); setScannerOpen(true); }}
            className="flex-1 sm:flex-initial flex items-center justify-center gap-2 bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 px-3.5 py-2 rounded-lg font-medium text-sm whitespace-nowrap"
          >
            <ScanLine size={18} className="shrink-0" /> Scan QR
          </button>
          <button
            onClick={handleExportPDF}
            className="flex-1 sm:flex-initial flex items-center justify-center gap-2 bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 px-3.5 py-2 rounded-lg font-medium text-sm whitespace-nowrap"
          >
            <FileDown size={18} className="shrink-0" /> Export PDF
          </button>
          <button
            onClick={openRestockModal}
            className="flex-1 sm:flex-initial flex items-center justify-center gap-2 bg-white border border-amber-300 hover:bg-amber-50 text-amber-700 px-3.5 py-2 rounded-lg font-medium text-sm whitespace-nowrap"
          >
            <Truck size={18} className="shrink-0" /> Restock Products
          </button>
          <button
            onClick={openAddModal}
            className="w-full sm:w-auto flex items-center justify-center gap-2 bg-primary-600 hover:bg-primary-700 text-white px-4 py-2 rounded-lg font-medium text-sm whitespace-nowrap"
          >
            <Plus size={18} className="shrink-0" /> Add Product
          </button>
        </div>
      </div>

      {dbNeedsMigration && (
        <div className="bg-amber-50 border border-amber-300 rounded-xl p-4 flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-[220px]">
            <p className="text-sm font-semibold text-amber-800">Product photos can't be saved yet — the database column is too small.</p>
            <p className="text-xs text-amber-700 mt-0.5">The live <code>products.image_url</code> column is still <code>VARCHAR(255)</code>, which rejects every photo. Click the button to widen it to <code>TEXT</code> (one-time fix — works for any logged-in staff).</p>
          </div>
          {!isDemo && <button
            onClick={runImageColumnMigration}
            disabled={migrating}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50"
          >
            {migrating ? 'Fixing…' : 'Fix database'}
          </button>}
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-3 sm:p-4 flex flex-col sm:flex-row sm:flex-wrap gap-3">
        <div className="relative flex-1 min-w-0 sm:min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or SKU..."
            className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="w-full sm:w-auto px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
        >
          <option value="">All Categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <select
          value={stockFilter}
          onChange={(e) => setStockFilter(e.target.value)}
          aria-label="Filter by stock status"
          className="w-full sm:w-auto px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
        >
          <option value="all">All stock statuses</option>
          <option value="in">In stock</option>
          <option value="low">Low stock</option>
          <option value="out">Out of stock</option>
        </select>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden min-w-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[920px]">
            <thead className="bg-gray-50">
              <tr className="text-left text-gray-500">
                <th className="py-3 px-4 whitespace-nowrap">Image</th>
                <th className="py-3 px-4 whitespace-nowrap">SKU</th>
                <th className="py-3 px-4 whitespace-nowrap">Name</th>
                <th className="py-3 px-4 whitespace-nowrap">Category</th>
                <th className="py-3 px-4 whitespace-nowrap">Stock</th>
                <th className="py-3 px-4 whitespace-nowrap">Base Unit</th>
                <th className="py-3 px-4 whitespace-nowrap">Cost (per base unit)</th>
                <th className="py-3 px-4 whitespace-nowrap">Suggested Retail Price (per base unit)</th>
                <th className="py-3 px-4 whitespace-nowrap text-right">Stock Value (at cost)</th>
                <th className="py-3 px-4 whitespace-nowrap">Status</th>
                <th className="py-3 px-4 text-right whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={11} className="text-center py-6 text-gray-400">Loading...</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={11} className="text-center py-6 text-gray-400">No products found</td></tr>
              ) : paginated.map((p) => {
                const lowStock = Number(p.stock_quantity) <= Number(p.low_stock_threshold);
                return (
                  <tr key={p.id} className="border-t border-gray-50 hover:bg-gray-50">
                    <td className="py-2 px-4 whitespace-nowrap">
                      {p.image_url ? (
                        <img
                          src={resolveProductImage(p.image_url)}
                          alt={p.name}
                          className="w-10 h-10 object-cover rounded-lg border border-gray-200 shadow-sm shrink-0"
                        />
                      ) : (
                        <div className="w-10 h-10 rounded-lg bg-gray-100 border border-gray-200 flex items-center justify-center text-gray-400 shrink-0">
                          <ImagePlus size={18} />
                        </div>
                      )}

                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-gray-500 whitespace-nowrap">{p.sku || '-'}</td>
                    <td className="py-3 px-4 font-medium text-gray-800 whitespace-nowrap">{p.name}</td>
                    <td className="py-3 px-4 whitespace-nowrap">{p.category_name || '-'}</td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      <span className="font-medium text-gray-800">{formatStock(p.stock_quantity)} {p.base_unit}</span>
                      <span className={`ml-2 inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${Number(p.stock_quantity) <= 0 ? 'bg-red-50 text-red-700' : lowStock ? 'bg-amber-50 text-amber-800' : 'bg-emerald-50 text-emerald-800'}`}>
                        {Number(p.stock_quantity) <= 0 ? 'Out of stock' : lowStock ? 'Low stock' : 'In stock'}
                      </span>
                      {(() => { const eq = formatEquivalent(p); return eq ? <div className="text-xs text-gray-400 font-normal mt-1">{eq}</div> : null; })()}
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap">{p.base_unit}</td>
                    <td className="py-3 px-4 whitespace-nowrap">{formatCurrency(p.cost)}</td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      {formatCurrency(p.price)}
                      {(() => { const breakdown = unitPriceBreakdown(p); return breakdown ? <div className="text-xs text-gray-400 font-normal">{breakdown}</div> : null; })()}
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap text-right">{formatCurrency(Number(p.stock_quantity) * Number(p.cost))}</td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${p.status === 'active' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-600'}`}>
                        {p.status}
                      </span>
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      <div className="flex justify-end gap-2">
                        <button onClick={() => openEditModal(p)} aria-label={`Edit ${p.name}`} className="p-2 rounded-lg hover:bg-primary-50 text-primary-700">
                          <Pencil size={16} />
                        </button>
                        <button onClick={() => generateQr(p)} title="Generate QR code" aria-label={`Generate QR code for ${p.name}`} className="p-2 rounded-lg hover:bg-emerald-50 text-emerald-700">
                          <QrCode size={16} />
                        </button>
                        {!isDemo && (
                          <button onClick={() => handleDelete(p.id)} aria-label={`Delete ${p.name}`} className="p-2 rounded-lg hover:bg-red-50 text-red-700">
                            <Trash2 size={16} />
                          </button>
                        )}
                        <button onClick={() => openBatchModal(p)} title="View batches (FIFO)" aria-label={`View batches for ${p.name}`} className="p-2 rounded-lg hover:bg-primary-50 text-primary-700">
                          <Package size={16} />
                        </button>
                        {!isDemo && (
                          <button
                            onClick={() => openSpoiledProductModal(p)}
                            title="Mark as spoiled"
                            aria-label={`Mark ${p.name} as spoiled`}
                            className="p-1.5 rounded-lg hover:bg-orange-50 text-orange-600"
                          >
                            <AlertTriangle size={16} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length > 0 && (
          <div className="flex items-center justify-between flex-wrap gap-2 px-4 py-3 border-t border-gray-100 text-sm text-gray-600">
            <span>
              Showing {(page - 1) * PAGE_SIZE + 1}-{Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                aria-label="Previous inventory page"
                disabled={page === 1}
                className="p-1.5 rounded-lg border border-gray-300 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="text-gray-600 text-xs sm:text-sm">Page {page} of {totalPages}</span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                aria-label="Next inventory page"
                disabled={page === totalPages}
                className="p-1.5 rounded-lg border border-gray-300 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}
      </div>

      {showRestockModal && (
        <div className="fixed inset-0 bg-gray-950/45 flex items-center justify-center z-50 p-3 sm:p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="restock-modal-title" className="bg-white rounded-2xl shadow-xl w-full max-w-4xl max-h-[calc(100dvh-1.5rem)] overflow-y-auto">
            <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-gray-100">
              <h2 id="restock-modal-title" className="font-semibold text-lg text-gray-900">Restock Products</h2>
              <button type="button" onClick={() => setShowRestockModal(false)} aria-label="Close restock form" className="p-2 rounded-lg text-gray-500 hover:bg-gray-100"><X size={20} /></button>
            </div>
            <form onSubmit={handleRestock} className="p-4 sm:p-6 space-y-4">
              {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2" role="alert">{error}</div>}
              <div className="space-y-4">
                {restockItems.map((item, index) => {
                  return (
                    <div key={`${index}-${item.product_id}`} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[1fr_95px_110px_115px_100px_auto] gap-3 items-end p-3 sm:p-0 bg-gray-50 sm:bg-transparent rounded-lg border sm:border-0 border-gray-200">
                      <div className="sm:col-span-2 lg:col-span-1">
                        <label className="block text-xs font-medium text-gray-600 mb-1">Product</label>
                        <select required value={item.product_id} onChange={(e) => { const np = products.find((pr) => String(pr.id) === String(e.target.value)); updateRestockItem(index, 'product_id', e.target.value); updateRestockItem(index, 'unit_id', (np?.units || []).find((u) => u.unit.toLowerCase() === String(np?.base_unit || 'kg').toLowerCase()) ? String((np?.units || []).find((u) => u.unit.toLowerCase() === String(np?.base_unit || 'kg').toLowerCase()).id) : ''); }}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500">
                          <option value="">Select product</option>
                          {products.map((pr) => (<option key={pr.id} value={pr.id}>{pr.name}</option>))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Quantity</label>
                        <input required min="0.01" step="0.01" type="number" value={item.quantity} onChange={(e) => updateRestockItem(index, 'quantity', e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Cost Price (Total)</label>
                        <input min="0" step="0.01" type="number" placeholder="Total paid" value={item.cost} onChange={(e) => updateRestockItem(index, 'cost', e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Cost per Base Unit (kg)</label>
                        <div className="px-3 py-2 border border-gray-200 rounded-lg bg-gray-50 text-sm text-gray-600 min-h-[38px] flex items-center">{computeCostPerKg(item.cost, item.quantity, item.unit_id ? Number(item.unit_multiplier) : 1) !== null ? formatCurrency(computeCostPerKg(item.cost, item.quantity, item.unit_id ? Number(item.unit_multiplier) : 1)) : '—'}
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Unit</label>
                        <select value={item.unit_id || ''} onChange={(e) => updateRestockItem(index, 'unit_id', e.target.value)}
                          className="w-full px-2 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500">
                          <option value="">Unit</option>
                          {(() => { const rp = products.find((pr) => String(pr.id) === String(item.product_id)); return ((rp?.units || []).filter((u) => u.is_purchase_unit !== 0).map((u) => (<option key={u.id} value={u.id}>{'Per ' + (u.label || u.unit) + (Number(u.multiplier_to_base) !== 1 ? ' (1 ' + u.unit + ' = ' + u.multiplier_to_base + ' ' + rp.base_unit + ')' : ' (base unit)')}</option>))); })()}
                        </select>
                      </div>
                      <div className="flex justify-end">
                        <button type="button" onClick={() => setRestockItems((items) => items.filter((_, itemIndex) => itemIndex !== index))}
                          disabled={restockItems.length === 1} className="p-2 mb-0.5 text-gray-400 hover:text-red-600 disabled:opacity-30">
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <button type="button" onClick={() => setRestockItems((items) => [...items, {}])}
                className="flex items-center gap-2 text-sm font-medium text-primary-600 hover:text-primary-700 pt-1">
                <Plus size={16} /> Add another product
              </button>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Supplier Name</label>
                <input value={restockSupplier} onChange={(e) => setRestockSupplier(e.target.value)}
                  placeholder="Supplier or farm name"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowRestockModal(false)} className="px-4 py-2 rounded-lg text-sm border border-gray-300 font-medium">Cancel</button>
                <button type="submit" className="px-4 py-2 rounded-lg text-sm bg-primary-600 hover:bg-primary-700 text-white font-medium">Restock</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 bg-gray-950/45 flex items-center justify-center z-50 p-3 sm:p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="product-modal-title" className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[calc(100dvh-1.5rem)] overflow-y-auto">
            <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-gray-100">
              <h2 id="product-modal-title" className="font-semibold text-lg text-gray-900">{editingId ? 'Edit Product' : 'Add Product'}</h2>
              <button type="button" onClick={handleCloseModal} aria-label="Close product form" className="p-2 rounded-lg text-gray-500 hover:bg-gray-100">
                <X size={20} />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-4 sm:p-6 space-y-4">
              {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2" role="alert">{error}</div>}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="col-span-1 sm:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Product Name</label>
                  <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">SKU</label>
                  <input required value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                  <select required value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500">
                    <option value="">Select category</option>
                    {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Base Unit</label>
                  <select value={form.base_unit || 'kg'} onChange={(e) => setForm({ ...form, base_unit: e.target.value, unit: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500">
                    <option value="kg">Kilogram (kg)</option>
                    <option value="g">Gram (g)</option>
                    <option value="pcs">Pieces (pcs)</option>
                    <option value="ton">Tone (ton)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                  <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500">
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Low Stock Alert</label>
                  <input type="number" step="0.01" value={form.low_stock_threshold} onChange={(e) => setForm({ ...form, low_stock_threshold: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Suggested Retail Price (per {form.base_unit || 'kg'})</label>
                  <input required min="0" step="0.01" type="number" value={form.price} onChange={(e) => handleRetailPriceChange(e.target.value)}
                    placeholder={form.price_auto ? `Auto: ${computeAutoPrice(form.costPrice, form.stock_quantity) !== null ? formatCurrency(computeAutoPrice(form.costPrice, form.stock_quantity)) : '—'}` : `Selling price per ${form.base_unit || 'kg'}`}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                {form.price_auto ? (
                  <span className="block text-xs text-emerald-600 mt-1">Auto from cost (20% markup)</span>
                ) : (
                  <button type="button" onClick={resetPriceToAuto} className="block text-left text-xs text-primary-600 hover:underline mt-1">
                    Reset to auto{computeAutoPrice(form.costPrice, form.stock_quantity) !== null ? ` (${formatCurrency(computeAutoPrice(form.costPrice, form.stock_quantity))})` : ''}
                  </button>
                )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Initial Stock ({form.base_unit || 'kg'})</label>
                  <input min="0" step="0.01" type="number" value={form.stock_quantity ?? ''} readOnly={Boolean(editingId)} onChange={(e) => handleStockQuantityChange(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                  <p className="text-xs text-gray-400 mt-1">{editingId ? 'Current stock — updated via Restock Products' : 'Initial stock quantity'}</p>
                </div>
                <div className="col-span-1 sm:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Cost Price</label>
                  <input min="0" step="0.01" type="number" value={form.costPrice} onChange={(e) => handleCostPriceChange(e.target.value)}
                    placeholder="Total amount paid for this stock purchase"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                </div>
                <div className="col-span-1 sm:col-span-2 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 flex items-center justify-between text-sm">
                  <span className="font-medium text-gray-600">Cost per Kilogram</span>
                  <span className="font-semibold text-gray-800">{computeCostPerKg(form.costPrice, form.stock_quantity) !== null ? formatCurrency(computeCostPerKg(form.costPrice, form.stock_quantity)) : '—'}</span>
                </div>
                <div className="col-span-1 sm:col-span-2 pt-4 border-t border-gray-200">
                  <h3 className="text-sm font-semibold text-gray-700 mb-3">Inventory &amp; Units</h3>
                  <div className="mb-3">
                    <label className="block text-xs text-gray-500 mb-1">Base unit for inventory: {form.base_unit || 'kg'}</label>
                  </div>
                  {form.units && form.units.map((unitItem, index) => (
                    <div key={index} className="mb-2 p-3 border border-gray-200 rounded-lg bg-gray-50/60">
                      <div className="flex flex-wrap items-start gap-3">
                        <div className="flex-1 min-w-[86px]">
                          <label className="block text-[10px] font-medium text-gray-500 mb-1">Unit</label>
                          <select value={unitItem.unit || 'kg'} onChange={(e) => handleUnitChange(index, 'unit', e.target.value)} className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-primary-500">{UNIT_OPTIONS.map((u) => (<option key={u} value={u}>{u}</option>))}</select>
                        </div>
                        <div className="flex-1 min-w-[110px]">
                          <label className="block text-[10px] font-medium text-gray-500 mb-1">Label</label>
                          <input value={unitItem.label || ''} onChange={(e) => handleUnitChange(index, 'label', e.target.value)} placeholder="e.g. Sack (50kg)" className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                        </div>
                        <div className="flex-1 min-w-[92px]">
                          <label className="block text-[10px] font-medium text-gray-500 mb-1">Multiplier</label>
                          <input type="number" min="0.001" step="0.001" value={unitItem.multiplier_to_base ?? ''} placeholder="1" onChange={(e) => handleUnitChange(index, 'multiplier_to_base', e.target.value)} className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                          <p className="text-[10px] text-gray-400 mt-0.5">1 {unitItem.unit || 'unit'} = {formatStock(normalizeMultiplier(unitItem.multiplier_to_base))} {form.base_unit || 'kg'}</p>
                        </div>
                        <div className="flex-1 min-w-[104px]">
                          <label className="block text-[10px] font-medium text-gray-500 mb-1">Unit Price</label>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={unitItem.price ?? ''}
                            onChange={(e) => handleUnitPriceChange(index, e.target.value)}
                            placeholder={computeUnitPrice(form.price, unitItem.multiplier_to_base) !== null ? String(computeUnitPrice(form.price, unitItem.multiplier_to_base)) : 'Unit price'}
                            className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                          />
                          {isAutoUnitPrice(unitItem) ? (
                            <span className="block text-[10px] text-emerald-600 mt-0.5">Auto from suggested retail price</span>
                          ) : (
                            <button type="button" onClick={() => resetUnitPriceToAuto(index)} className="block text-left text-[10px] text-primary-600 hover:underline mt-0.5">
                              Reset to auto{computeUnitPrice(form.price, unitItem.multiplier_to_base) !== null ? ` (${formatCurrency(computeUnitPrice(form.price, unitItem.multiplier_to_base))})` : ''}
                            </button>
                          )}
                        </div>
                        <div className="flex-1 min-w-[128px]">
                          <label className="block text-[10px] font-medium text-gray-500 mb-1">Use For</label>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1.5">
                            <label className="inline-flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={unitItem.is_purchase_unit !== 0} onChange={(e) => handleUnitChange(index, 'is_purchase_unit', e.target.checked ? 1 : 0)} className="h-3.5 w-3.5 rounded" /><span className="text-xs">Purchase</span></label>
                            <label className="inline-flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={unitItem.is_sales_unit !== 0} onChange={(e) => handleUnitChange(index, 'is_sales_unit', e.target.checked ? 1 : 0)} className="h-3.5 w-3.5 rounded" /><span className="text-xs">Sale</span></label>
                          </div>
                        </div>
                        <div className="flex items-start justify-end pt-4">
                          <button type="button" onClick={() => removeUnit(index)} disabled={form.units.length === 1} className="p-1 text-gray-400 hover:text-red-600 disabled:opacity-30">
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                  <button type="button" onClick={addUnit} className="text-sm font-medium text-primary-600 hover:text-primary-700 pt-1">+ Add Unit</button>
                </div>
              </div>
              <div className="col-span-1 sm:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Product Image</label>
                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={handleImageDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className="border-2 border-dashed border-gray-300 rounded-lg p-4 text-center cursor-pointer hover:border-primary-400 hover:bg-primary-50/30 transition-colors"
                >
                  {imagePreview ? (
                    <div className="relative">
                      <img
                        src={resolveProductImage(imagePreview)}
                        alt="Product preview"
                        className="w-32 h-32 object-cover rounded-lg mx-auto"
                      />
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleRemoveImage(); }}
                        className="absolute top-0 right-1/2 translate-x-16 -translate-y-1 bg-red-500 text-white rounded-full p-0.5 hover:bg-red-600"
                      >
                        <X size={14} />
                      </button>
                      <p className="text-xs text-gray-500 mt-2">Click or drag to replace</p>
                    </div>
                  ) : (
                    <div className="py-3">
                      <ImagePlus size={32} className="mx-auto text-gray-400 mb-2" />
                      <p className="text-sm text-gray-500">{uploading ? 'Uploading...' : 'Click or drag an image here'}</p>
                      <p className="text-xs text-gray-400 mt-1">JPEG, PNG, or WebP · Auto-compressed to ~2 MB max</p>
                    </div>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="hidden"
                    onChange={(e) => handleImageUpload(e.target.files[0])}
                  />
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-2 col-span-1 sm:col-span-2">
                <button type="button" onClick={handleCloseModal} className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100">
                  Cancel
                </button>
                <button type="submit" disabled={uploading} className="px-4 py-2 rounded-lg text-sm font-medium bg-primary-600 hover:bg-primary-700 text-white disabled:opacity-50">
                  {uploading ? 'Uploading...' : editingId ? 'Save Changes' : 'Add Product'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {qrProduct && (
        <div className="fixed inset-0 bg-gray-950/45 flex items-center justify-center z-50 p-3 sm:p-4">
          <div role="dialog" aria-modal="true" aria-label="Product QR code" className="bg-white rounded-2xl shadow-xl w-full max-w-sm max-h-[calc(100dvh-1.5rem)] overflow-y-auto p-5 sm:p-6 text-center">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold text-lg text-gray-800">Product QR Code</h2>
              <button type="button" onClick={() => setQrProduct(null)} aria-label="Close product QR code" className="p-2 rounded-lg text-gray-500 hover:bg-gray-100"><X size={20} /></button>
            </div>
            {qrProduct.image_url && (
             <img src={resolveProductImage(qrProduct.image_url)} alt={qrProduct.name} className="w-20 h-20 object-cover rounded-lg mx-auto mb-3" />
            )}
            <img src={qrImage} alt={`QR code for ${qrProduct.name}`} className="w-56 h-56 mx-auto" />
            <p className="font-semibold text-gray-800 mt-3">{qrProduct.name}</p>
            <p className="text-sm text-gray-500">{qrProduct.sku || 'No SKU'} · {qrProduct.category_name || 'Uncategorized'}</p>
            <a href={qrImage} download={`${qrProduct.sku || qrProduct.name}-qr.png`} className="inline-block mt-4 px-4 py-2 rounded-lg bg-primary-600 text-white text-sm font-medium">Download QR</a>
          </div>
        </div>
      )}

      {scannerOpen && (
        <div className="fixed inset-0 bg-gray-950/45 flex items-center justify-center z-50 p-3 sm:p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="scanner-modal-title" className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[calc(100dvh-1.5rem)] overflow-y-auto p-5 sm:p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 id="scanner-modal-title" className="font-semibold text-lg text-gray-900">Scan Product QR Code</h2>
              <button type="button" onClick={() => setScannerOpen(false)} aria-label="Close QR scanner" className="p-2 rounded-lg text-gray-500 hover:bg-gray-100"><X size={20} /></button>
            </div>
            <div id="vegietrack-qr-reader" className="overflow-hidden rounded-lg" />
            <p className="text-xs text-gray-500 mt-3">Allow camera access and point it at a VegieTrack product QR code.</p>
          </div>
        </div>
      )}

      {scannedProduct && (
        <div className="fixed inset-0 bg-gray-950/45 flex items-center justify-center z-50 p-3 sm:p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="scanned-product-title" className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[calc(100dvh-1.5rem)] overflow-y-auto p-5 sm:p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 id="scanned-product-title" className="font-semibold text-lg text-gray-900">Scanned Product</h2>
              <button type="button" onClick={() => setScannedProduct(null)} aria-label="Close scanned product details" className="p-2 rounded-lg text-gray-500 hover:bg-gray-100"><X size={20} /></button>
            </div>
            {scannedProduct.image_url ? (
             <img src={resolveProductImage(scannedProduct.image_url)} alt={scannedProduct.name} className="w-full h-48 object-cover rounded-lg mb-4" />
            ) : (
              <div className="w-full h-48 bg-gray-100 rounded-lg mb-4 flex items-center justify-center">
                <ImagePlus size={48} className="text-gray-300" />
              </div>
            )}
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-gray-500">Name</dt><dd className="font-medium">{scannedProduct.name}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">SKU</dt><dd>{scannedProduct.sku || '-'}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Category</dt><dd>{scannedProduct.category_name || '-'}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Suggested Retail Price (per {scannedProduct.base_unit || 'unit'})</dt><dd>{formatCurrency(scannedProduct.price)}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Stock</dt><dd>{formatStock(scannedProduct.stock_quantity)} {scannedProduct.base_unit}</dd></div>
            </dl>
          </div>
        </div>
      )}
      {batchProduct && (
        <div className="fixed inset-0 bg-gray-950/45 flex items-center justify-center z-50 p-3 sm:p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="batch-modal-title" className="bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[calc(100dvh-1.5rem)] overflow-y-auto">
            <div className="flex items-center justify-between p-4 sm:p-6 border-b">
              <h2 id="batch-modal-title" className="font-semibold text-lg text-gray-900">Batches — {batchProduct.name}</h2>
              <button type="button" onClick={() => setBatchProduct(null)} aria-label="Close batch details" className="p-2 rounded-lg text-gray-500 hover:bg-gray-100"><X size={20} /></button>
            </div>
            {batchError && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2 m-4" role="alert">{batchError}</div>}
            <div className="p-4 sm:p-6">
              <div className="flex gap-2 mb-4">
                <button
                  onClick={() => setBatchTab('new')}
                  aria-pressed={batchTab === 'new'}
                  className={`px-4 py-2 rounded-lg text-sm font-medium ${batchTab === 'new' ? 'bg-primary-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
                >
                  New Purchases
                </button>
                <button
                  onClick={() => setBatchTab('old')}
                  aria-pressed={batchTab === 'old'}
                  className={`px-4 py-2 rounded-lg text-sm font-medium ${batchTab === 'old' ? 'bg-amber-700 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
                >
                  Old Purchases (Near Expiry)
                </button>
              </div>
              {batchesLoading ? (
                <div className="text-center py-6 text-gray-400">Loading batches...</div>
              ) : batches.length === 0 ? (
                <div className="text-center py-6 text-gray-400">No batches found for this product.</div>
              ) : (
                (() => {
                  const today = new Date();
                  const sorted = [...batches].sort((a, b) => new Date(a.purchase_date) - new Date(b.purchase_date));
                  const displayed = batchTab === 'old'
                    ? sorted.filter(b => {
                        const diffDays = (today - new Date(b.purchase_date)) / (1000 * 60 * 60 * 24);
                        const shelfLife = Number(b.shelf_life_days || batchProduct.shelf_life_days || 5);
                        return diffDays >= shelfLife;
                      })
                    : sorted;
                  return (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50">
                          <tr className="text-left text-gray-500">
                            <th className="py-3 px-4 whitespace-nowrap">Purchase Date</th>
                            <th className="py-3 px-4 whitespace-nowrap">Remaining Qty</th>
                            <th className="py-3 px-4 whitespace-nowrap">Original Qty</th>
                            <th className="py-3 px-4 whitespace-nowrap">Cost per Base Unit</th>
                            <th className="py-3 px-4 whitespace-nowrap">Status</th>
                          </tr>
                        </thead>
                        <tbody>

                          {displayed.map((b) => {
                            const diffDays = (today - new Date(b.purchase_date)) / (1000 * 60 * 60 * 24);
                            const shelfLife = Number(b.shelf_life_days || batchProduct.shelf_life_days || 5);
                            const isSpoiled = diffDays >= shelfLife;
                            const remaining = Number(b.quantity);
                            return (
                              <tr key={b.id} className="border-t border-gray-50">
                                <td className="py-2.5 px-4 whitespace-nowrap">{b.purchase_date || '-'}</td>
                                <td className="py-2.5 px-4 whitespace-nowrap">{formatStock(remaining)}</td>
                                <td className="py-2.5 px-4 whitespace-nowrap">{formatStock(b.original_quantity)}</td>
                                <td className="py-2.5 px-4 whitespace-nowrap">{b.cost_per_base ? formatCurrency(b.cost_per_base) : '-'}</td>
                                <td className="py-2.5 px-4 whitespace-nowrap">
                                  {remaining <= 0 ? (
                                    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">Consumed</span>
                                  ) : isSpoiled ? (
                                    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">Spoiled</span>
                                  ) : (
                                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${diffDays >= shelfLife * 0.8 ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>
                                      {diffDays >= shelfLife * 0.8 ? 'Near Expiry' : 'Fresh'}
                                    </span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  );
                })()
              )}
            </div>
          </div>
        </div>
      )}

      {showSpoiledProductPicker && (
        <div className="fixed inset-0 bg-gray-950/45 flex items-center justify-center z-50 p-3 sm:p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="spoiled-product-picker-title" className="bg-white rounded-2xl shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-gray-100">
              <h2 id="spoiled-product-picker-title" className="font-semibold text-lg text-gray-900">Select a product to spoil</h2>
              <button type="button" onClick={() => navigate(location.pathname, { replace: true, state: null })} className="text-gray-400 hover:text-gray-600" aria-label="Close">
                <X size={20} />
              </button>
            </div>
            <div className="p-4 sm:p-6">
              {products.length === 0 ? (
                <p className="text-sm text-gray-500">No products are available to record as spoiled.</p>
              ) : (
                <div className="max-h-80 overflow-y-auto space-y-2">
                  {products.map((product) => (
                    <button
                      key={product.id}
                      type="button"
                      onClick={() => {
                        navigate(location.pathname, { replace: true, state: null });
                        openSpoiledProductModal(product);
                      }}
                      className="w-full flex items-center justify-between gap-3 rounded-lg border border-gray-200 px-3 py-2 text-left hover:bg-gray-50"
                    >
                      <span className="font-medium text-sm text-gray-800">{product.name}</span>
                      <span className="text-xs text-gray-500">{formatStock(product.stock_quantity)} {product.base_unit || 'kg'} available</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showSpoiledModal && (
        <div className="fixed inset-0 bg-gray-950/45 flex items-center justify-center z-50 p-3 sm:p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="spoiled-modal-title" className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[calc(100dvh-1.5rem)] overflow-y-auto">
            <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-gray-100">
              <div className="min-w-0">
                <h2 id="spoiled-modal-title" className="font-semibold text-lg text-gray-900">Mark as Spoiled</h2>
                <p className="text-xs text-gray-500 truncate">{spoiledProductName}</p>
              </div>
              <button onClick={closeSpoiledModal} className="text-gray-400 hover:text-gray-600 shrink-0" aria-label="Close">
                <X size={20} />
              </button>
            </div>
            <div className="p-4 sm:p-6 space-y-4">
              {spoiledError && (
                <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2" role="alert">{spoiledError}</div>
              )}
              {spoiledBatchWarning && (
                <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-lg px-3 py-2" role="status">{spoiledBatchWarning}</div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="bg-amber-50 border border-amber-100 text-amber-900 rounded-xl p-3">
                  <p className="text-xs text-amber-800">Available in selected batch</p>
                  <p className="mt-1 text-sm font-semibold">
                    {formatStock(selectedSpoiledBatch?.quantity ?? spoiledAvailableStock)} {spoiledUnit}
                  </p>
                </div>
                <div className="bg-gray-50 border border-gray-100 text-gray-800 rounded-xl p-3">
                  <p className="text-xs text-gray-500">Cost price per {spoiledUnit}</p>
                  <p className="mt-1 text-sm font-semibold">{formatCurrency(spoiledCostPrice)}</p>
                </div>
              </div>

              <div>
                <label htmlFor="spoiled-batch" className="block text-xs font-medium text-gray-600 mb-1">
                  Purchase Batch (FIFO)
                </label>
                <select
                  id="spoiled-batch"
                  value={spoiledProduct.batch_id}
                  onChange={(e) => setSpoiledProduct((prev) => ({ ...prev, batch_id: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                >
                  <option value="">All stock (no specific batch)</option>
                  {spoiledBatches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.purchase_date} — {formatStock(b.quantity)} {spoiledUnit} remaining · {formatCurrency(b.cost_per_base ?? selectedSpoiledProduct?.cost ?? 0)}/unit
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="spoiled-quantity" className="block text-xs font-medium text-gray-600 mb-1">
                  Quantity ({spoiledUnit})
                </label>
                <input
                  id="spoiled-quantity"
                  type="number"
                  min="0.01"
                  max={selectedSpoiledBatch?.quantity ?? spoiledAvailableStock}
                  step="0.01"
                  value={spoiledProduct.quantity}
                  onChange={(e) => setSpoiledProduct((prev) => ({ ...prev, quantity: e.target.value }))}
                  placeholder="0"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>

              <div className="rounded-xl border border-orange-200 bg-orange-50 px-4 py-3">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-orange-900">Estimated spoiled loss</span>
                  <span className="font-semibold text-orange-950">{formatCurrency(spoiledLossPreview)}</span>
                </div>
                <p className="mt-1 text-xs text-orange-800">
                  {formatStock(spoiledProduct.quantity || 0)} × {formatCurrency(spoiledCostPrice)} cost price
                </p>
              </div>
              <p className="text-xs text-gray-500">
                Date: {new Date().toLocaleDateString()} · Recorded when you submit
              </p>

              <div>
                <label htmlFor="spoiled-reason" className="block text-xs font-medium text-gray-600 mb-1">
                  Reason
                </label>
                <textarea
                  id="spoiled-reason"
                  rows="2"
                  value={spoiledProduct.reason}
                  onChange={(e) => setSpoiledProduct((prev) => ({ ...prev, reason: e.target.value }))}
                  placeholder="e.g. Rotated, bruised, expired..."
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={closeSpoiledModal}
                  disabled={spoiledSubmitting}
                  className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSpoiledSubmit}
                  disabled={spoiledSubmitting}
                  className="px-4 py-2 rounded-lg text-sm font-medium bg-orange-600 hover:bg-orange-700 text-white disabled:opacity-50 flex items-center gap-2"
                >
                  <AlertTriangle size={16} />
                  {spoiledSubmitting ? 'Saving...' : 'Record Spoilage'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
