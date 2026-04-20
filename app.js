/*
 * Lot Suggestion Tool — all React components + API logic in one file.
 * Loaded in index.html as <script type="text/babel">, so JSX works.
 *
 * Structure:
 *   1. Constants (model, system prompt, localStorage keys)
 *   2. Anthropic API wrapper (suggestLots)
 *   3. Four UI components (KeyInput, PhotoUpload, LotControls, LotsView)
 *   4. Top-level <App /> that wires state together
 *   5. Mount into #root
 */

const { useState, useEffect, useRef } = React;

// ======================== 1. Constants ========================

const MODEL = 'claude-sonnet-4-6';
const LS_API_KEY = 'lot-tool.apiKey';
const LS_CATEGORY = 'lot-tool.lastCategory';

const SYSTEM_PROMPT = `You are an expert in identifying collectible and resale items from photographs and organizing them into coherent lots for sale on eBay.

Given one or more photos of a batch of items, you will:
1. Identify every distinct item visible across all photos. For each, provide a short descriptive name (e.g. "Pink Floyd - Dark Side of the Moon CD", "Vogue 7823 sewing pattern, size 12").
2. Propose groupings ("lots") that would sell well together on eBay. Good lots share a theme: same genre, same era, same artist family, same craft style, same collector niche, etc.
3. For each lot, give it a punchy title, explain the theme, and list which items belong in it.

Prioritize coherence of lots over exact lot count. A tight themed lot of 4 items sells better than a grab-bag of 7.

Respond ONLY with valid JSON matching this schema, no prose before or after:

{
  "items": [
    { "id": "item-1", "name": "string", "notes": "string (optional brief notes on condition/era/etc)" }
  ],
  "lots": [
    {
      "id": "lot-1",
      "title": "string (punchy eBay-style title)",
      "theme": "string (one sentence explaining why these go together)",
      "item_ids": ["item-1", "item-3"]
    }
  ],
  "unassigned_item_ids": ["item-7"],
  "notes_to_seller": "string (optional tips, e.g. 'item-4 appears damaged; consider selling separately')"
}`;

// ======================== 2. API wrapper ========================

// Convert a File (from <input type="file">) into base64, as required by the API.
async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      resolve({ data: base64, mediaType: file.type });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Main API call. Given the user's key + photos + knobs, returns parsed JSON.
async function suggestLots({ apiKey, images, targetLotCount, fuzzy, itemCategory }) {
  if (!apiKey) throw new Error('No API key provided.');
  if (!images || images.length === 0) throw new Error('At least one photo is required.');

  // Turn each photo into an image content block the API expects.
  const imageBlocks = await Promise.all(
    images.map(async (img) => {
      const { data, mediaType } = await fileToBase64(img);
      return {
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data }
      };
    })
  );

  const countInstruction = fuzzy
    ? `Aim for about ${targetLotCount} lots, but deviate up or down if that produces more coherent groupings.`
    : `Produce exactly ${targetLotCount} lots.`;

  const categoryHint = itemCategory
    ? `The items in these photos are primarily ${itemCategory}.`
    : '';

  const userText = `${categoryHint}\n\n${countInstruction}\n\nAnalyze the attached photo(s) and return your JSON response.`.trim();

  // Direct call to the Anthropic API. The special header lets browsers call it.
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [...imageBlocks, { type: 'text', text: userText }]
        }
      ]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`API error ${response.status}: ${errText}`);
  }

  const result = await response.json();
  const textBlock = (result.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Claude returned no text response.');

  // Parse the JSON reply. Fallback: grab the first {...} block if Claude added prose.
  const raw = textBlock.text.trim();
  let jsonString = raw;
  if (!raw.startsWith('{')) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Could not find JSON in Claude response.');
    jsonString = match[0];
  }

  try {
    return JSON.parse(jsonString);
  } catch (err) {
    console.error('Failed to parse Claude response:', raw);
    throw new Error('Claude response was not valid JSON.');
  }
}

// ======================== 3. UI components ========================

function KeyInput({ apiKey, onChange }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800 p-4">
      <label className="block text-sm font-medium text-slate-300 mb-2">
        Anthropic API key
      </label>
      <div className="flex gap-2">
        <input
          type={visible ? 'text' : 'password'}
          value={apiKey}
          onChange={(e) => onChange(e.target.value)}
          placeholder="sk-ant-..."
          className="flex-1 rounded bg-slate-900 border border-slate-700 px-3 py-2 text-sm font-mono text-slate-100"
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="rounded bg-slate-700 hover:bg-slate-600 px-3 py-2 text-sm"
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      </div>
      <p className="text-xs text-slate-400 mt-2">
        Stored only in this browser. Get one at{' '}
        <a href="https://console.anthropic.com" target="_blank" rel="noreferrer" className="underline">
          console.anthropic.com
        </a>.
      </p>
    </div>
  );
}

function PhotoUpload({ images, onChange }) {
  const inputRef = useRef(null);

  function handleFiles(e) {
    const files = Array.from(e.target.files || []);
    onChange([...images, ...files]);
    e.target.value = ''; // allow re-picking the same file after removal
  }

  function removeAt(idx) {
    onChange(images.filter((_, i) => i !== idx));
  }

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800 p-4">
      <label className="block text-sm font-medium text-slate-300 mb-2">
        Photos ({images.length})
      </label>

      {images.length > 0 && (
        <div className="grid grid-cols-3 gap-2 mb-3">
          {images.map((file, i) => (
            <div key={i} className="relative">
              <img
                src={URL.createObjectURL(file)}
                alt={`upload ${i + 1}`}
                className="w-full h-24 object-cover rounded"
              />
              <button
                onClick={() => removeAt(i)}
                className="absolute top-1 right-1 bg-slate-900/80 hover:bg-red-600 rounded-full w-6 h-6 text-xs"
                aria-label="Remove photo"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        onChange={handleFiles}
        className="hidden"
      />
      <button
        type="button"
        onClick={() => inputRef.current && inputRef.current.click()}
        className="w-full rounded bg-indigo-600 hover:bg-indigo-500 py-3 text-sm font-medium"
      >
        {images.length === 0 ? 'Add photos' : 'Add more photos'}
      </button>
    </div>
  );
}

function LotControls({
  targetLotCount,
  fuzzy,
  itemCategory,
  onChangeLotCount,
  onChangeFuzzy,
  onChangeCategory
}) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800 p-4 space-y-4">
      <div>
        <label className="block text-sm font-medium text-slate-300 mb-2">
          Target number of lots
        </label>
        <input
          type="number"
          min={1}
          max={50}
          value={targetLotCount}
          onChange={(e) => onChangeLotCount(Number(e.target.value))}
          className="w-24 rounded bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-100"
        />
        <label className="inline-flex items-center ml-4 text-sm">
          <input
            type="checkbox"
            checked={fuzzy}
            onChange={(e) => onChangeFuzzy(e.target.checked)}
            className="mr-2"
          />
          Fuzzy (prioritize coherent themes over exact count)
        </label>
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-300 mb-2">
          Item category (optional)
        </label>
        <input
          type="text"
          value={itemCategory}
          onChange={(e) => onChangeCategory(e.target.value)}
          placeholder="e.g. CDs, vinyl records, matchbooks, sewing patterns"
          className="w-full rounded bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-100"
        />
      </div>
    </div>
  );
}

function LotsView({ result }) {
  if (!result) return null;
  const itemsById = Object.fromEntries((result.items || []).map((it) => [it.id, it]));

  return (
    <div className="space-y-4">
      {(result.lots || []).map((lot) => (
        <div key={lot.id} className="rounded-lg border border-slate-700 bg-slate-800 p-4">
          <h3 className="text-lg font-semibold text-indigo-300">{lot.title}</h3>
          <p className="text-sm text-slate-400 italic mb-3">{lot.theme}</p>
          <ul className="list-disc list-inside space-y-1 text-sm">
            {lot.item_ids.map((iid) => {
              const item = itemsById[iid];
              if (!item) return null;
              return (
                <li key={iid}>
                  <span className="font-medium">{item.name}</span>
                  {item.notes && <span className="text-slate-400"> — {item.notes}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      {result.unassigned_item_ids && result.unassigned_item_ids.length > 0 && (
        <div className="rounded-lg border border-amber-700 bg-amber-900/30 p-4">
          <h3 className="text-lg font-semibold text-amber-300 mb-2">Unassigned items</h3>
          <ul className="list-disc list-inside space-y-1 text-sm">
            {result.unassigned_item_ids.map((iid) => {
              const item = itemsById[iid];
              if (!item) return null;
              return <li key={iid}>{item.name}</li>;
            })}
          </ul>
        </div>
      )}

      {result.notes_to_seller && (
        <div className="rounded-lg border border-slate-700 bg-slate-800 p-4">
          <h3 className="text-sm font-semibold text-slate-300 mb-1">Notes</h3>
          <p className="text-sm text-slate-300">{result.notes_to_seller}</p>
        </div>
      )}
    </div>
  );
}

// ======================== 4. Top-level App ========================

function App() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(LS_API_KEY) || '');
  const [images, setImages] = useState([]);
  const [targetLotCount, setTargetLotCount] = useState(5);
  const [fuzzy, setFuzzy] = useState(true);
  const [itemCategory, setItemCategory] = useState(() => localStorage.getItem(LS_CATEGORY) || '');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  useEffect(() => {
    localStorage.setItem(LS_API_KEY, apiKey);
  }, [apiKey]);

  useEffect(() => {
    localStorage.setItem(LS_CATEGORY, itemCategory);
  }, [itemCategory]);

  async function handleSubmit() {
    setError('');
    setResult(null);
    setLoading(true);
    try {
      const res = await suggestLots({
        apiKey,
        images,
        targetLotCount,
        fuzzy,
        itemCategory
      });
      setResult(res);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  const canSubmit = apiKey && images.length > 0 && !loading;

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4">
      <header className="py-4">
        <h1 className="text-2xl font-bold">Lot Suggestion Tool</h1>
        <p className="text-sm text-slate-400">
          Photograph a batch of items. Claude groups them into themed lots for eBay.
        </p>
      </header>

      <KeyInput apiKey={apiKey} onChange={setApiKey} />
      <PhotoUpload images={images} onChange={setImages} />
      <LotControls
        targetLotCount={targetLotCount}
        fuzzy={fuzzy}
        itemCategory={itemCategory}
        onChangeLotCount={setTargetLotCount}
        onChangeFuzzy={setFuzzy}
        onChangeCategory={setItemCategory}
      />

      <button
        onClick={handleSubmit}
        disabled={!canSubmit}
        className="w-full rounded bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-500 py-3 font-medium"
      >
        {loading ? 'Thinking…' : 'Suggest lots'}
      </button>

      {error && (
        <div className="rounded border border-red-700 bg-red-900/40 p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <LotsView result={result} />

      <footer className="text-xs text-slate-500 text-center py-6">
        Your API key stays on this device. Calls go directly to Anthropic.
      </footer>
    </div>
  );
}

// ======================== 5. Mount ========================

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
