/*
 * Lot Suggestion Tool — all React components + API logic in one file.
 * Loaded in index.html as <script type="text/babel">, so JSX works.
 *
 * Structure:
 *   1. Constants and system prompts
 *   2. Image compression helpers
 *   3. Anthropic API wrappers (initial call, stragglers, dissolve-reassign)
 *   4. State-merge helpers (stragglers, reassignments)
 *   5. UI components
 *   6. Top-level <App />
 *   7. Mount
 */

const { useState, useEffect, useRef } = React;

// ======================== 1. Constants & prompts ========================

const MODEL = 'claude-sonnet-4-6';
const LS_API_KEY = 'lot-tool.apiKey';
const LS_CATEGORY = 'lot-tool.lastCategory';

const MAX_BASE64_BYTES = 5 * 1024 * 1024; // Anthropic's per-image cap (5 MiB)
const MAX_IMAGE_DIMENSION = 2000;         // px cap on the longest side

// Shared preamble describing the JSON conventions Claude should use.
const JSON_CONVENTIONS = `Item IDs look like "item-1", "item-2" etc. Lot IDs look like "lot-1", "lot-2" etc.

Each item has a "source" field labeling where it came from:
- "Photo 1", "Photo 2", ... for the initial batch of photos (in order attached)
- "Straggler photo 1", "Straggler photo 2", ... for additional photos submitted later
- "Straggler text" for items typed as text descriptions

Every lot has:
- "title": a richer display title that can reference theme, era, artists (80+ chars OK)
- "short_title": an ultra-compact label naming ONLY what unifies the lot — the single theme or connection that ties it together. Target 3 words; use 4 or 5 only if truly necessary. NOT a keyword-rich listing title. NOT a list of contents or artists. NOT a description. Just the unifier. Good examples: "70s Prog Rock", "Women's Vogue Patterns", "Chicago Matchbooks", "Delta Blues Revival", "Cold War Thrillers". Bad (too long/too specific): "Classic 70s Prog Rock CD Lot of 5 — Pink Floyd Yes Genesis".
- "theme": one sentence explaining why the items belong together.
- "item_ids": the list of item IDs in the lot.`;

const INITIAL_SYSTEM_PROMPT = `You are an expert at identifying collectibles for eBay resale and organizing them into coherent lots.

${JSON_CONVENTIONS}

Your task on this initial submission:
1. Identify every distinct item visible across all attached photos. Give each a short descriptive name and its source photo label.
2. Propose themed lots. Good lots share a theme (genre, era, artist family, collector niche, craft style).
3. Prioritize coherence over hitting the exact lot count. A tight themed lot of 4 sells better than a grab-bag of 7.
4. Use "not_recommended" sparingly — only for items that genuinely shouldn't be in a lot (obvious damage, extremely low value, doesn't fit the category).

Respond ONLY with valid JSON in this exact shape:

{
  "items": [
    { "id": "item-1", "name": "string", "source": "Photo 1", "notes": "string (optional: condition, era, edition)" }
  ],
  "lots": [
    {
      "id": "lot-1",
      "title": "string",
      "short_title": "string (3 words ideal, 5 max; the unifier only)",
      "theme": "string",
      "item_ids": ["item-1", "item-3"]
    }
  ],
  "unassigned_item_ids": [],
  "not_recommended": [
    { "item_id": "item-N", "reason": "string" }
  ],
  "notes_to_seller": "string (optional overall tips)"
}`;

const STRAGGLERS_SYSTEM_PROMPT = `You are adding newly submitted items to an existing eBay lot organization.

${JSON_CONVENTIONS}

You will receive:
- The current state (existing items + existing lots)
- New items to integrate, either as new photos and/or as typed text descriptions

Your task:
1. Identify each new item. Assign a new unique ID like "item-<N>" that does NOT collide with existing item IDs.
2. Set "source" correctly: "Straggler photo <n>" for the nth straggler photo in this batch, or "Straggler text" for typed items.
3. Place each new item into the most coherent EXISTING lot.
4. Only create a new lot when no existing lot is a reasonable fit AND you have at least 2 items for it.
5. DO NOT modify the item_ids of existing lots — you may only ADD new items to them through the "assignments" list.
6. Use "not_recommended" sparingly for new items that shouldn't be lotted.

Respond ONLY with valid JSON:

{
  "new_items": [
    { "id": "item-<N>", "name": "string", "source": "Straggler photo 1 | Straggler text", "notes": "string (optional)" }
  ],
  "assignments": [
    { "lot_id": "lot-existing-id", "item_ids": ["item-<N>"] }
  ],
  "new_lots": [
    {
      "id": "lot-<new-id>",
      "title": "string",
      "short_title": "string",
      "theme": "string",
      "item_ids": ["item-<N>"]
    }
  ],
  "unassigned_item_ids": [],
  "not_recommended": [
    { "item_id": "item-<N>", "reason": "string" }
  ]
}`;

const DISSOLVE_SYSTEM_PROMPT = `You are redistributing items from a dissolved lot into the remaining existing lots.

You will receive:
- The remaining lot structure
- A list of items that need new homes, each with its existing ID

Your task:
1. Assign each provided item to the single best-fitting remaining lot.
2. DO NOT create new lots.
3. DO NOT modify assignments of other items.
4. If an item truly fits no remaining lot, include its ID in "unassigned_item_ids".

Respond ONLY with valid JSON:

{
  "assignments": [
    { "lot_id": "lot-existing-id", "item_ids": ["item-N"] }
  ],
  "unassigned_item_ids": []
}`;

// ======================== 2. Image compression ========================

async function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      resolve({ data: base64, mediaType: blob.type || 'image/jpeg' });
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Decode a File into something canvas-drawable. Tries createImageBitmap first
// (faster, handles more formats) and falls back to an <img> element.
async function decodeImage(file) {
  const fileInfo = `"${file.name || 'unnamed'}" (type: ${file.type || 'unknown'}, ${Math.round((file.size || 0) / 1024)} KB)`;

  // HEIC/HEIF is the most common failure mode on Android. Catch it with a clear message.
  const nameLower = (file.name || '').toLowerCase();
  const isHeic = /image\/hei[cf]/.test(file.type || '') ||
                 nameLower.endsWith('.heic') || nameLower.endsWith('.heif');
  if (isHeic) {
    throw new Error(
      `${fileInfo} is in HEIC/HEIF format, which Chrome can't read in-browser. ` +
      `Fix: open your camera app settings and switch the photo format to JPEG (sometimes called "Most compatible"), or re-save this photo as JPEG. Then retry.`
    );
  }

  if (!file.size || file.size === 0) {
    throw new Error(
      `${fileInfo} has zero bytes. If you picked it from Google Photos, it may still be in the cloud — open it in the Photos app once to download it locally, then retry.`
    );
  }

  // Primary path: createImageBitmap (fast, async-decodes).
  try {
    return await createImageBitmap(file);
  } catch (_) {
    // Fall through to <img> fallback.
  }

  // Fallback: <img> element + object URL.
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error(
        `Could not decode image ${fileInfo}. The file may be corrupt or in an unsupported format.`
      ));
      i.src = objectUrl;
    });
    // Keep the URL alive for the caller to draw from; caller should revoke.
    img._objectUrl = objectUrl;
    return img;
  } catch (err) {
    URL.revokeObjectURL(objectUrl);
    throw err;
  }
}

// Formats Claude accepts directly as image content.
const SUPPORTED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

async function compressImage(file) {
  // HEIC/zero-byte detection runs regardless of the fast path.
  const nameLower = (file.name || '').toLowerCase();
  const isHeic = /image\/hei[cf]/.test(file.type || '') ||
                 nameLower.endsWith('.heic') || nameLower.endsWith('.heif');
  if (isHeic) {
    throw new Error(
      `"${file.name || 'unnamed'}" is in HEIC/HEIF format, which Chrome can't read in-browser. ` +
      `Fix: open your camera settings and switch the photo format to JPEG (sometimes called "Most compatible"), or re-save this photo as JPEG.`
    );
  }
  if (!file.size || file.size === 0) {
    throw new Error(
      `"${file.name || 'unnamed'}" has zero bytes. If you picked it from Google Photos, it may still be in the cloud — open it once in the Photos app to download it locally, then retry.`
    );
  }

  // Fast path: if the file is already a supported format and small enough,
  // base64-encode the bytes directly and skip decoding entirely. This avoids
  // the (sometimes-fragile) browser image decode step for images that don't
  // need resizing — which is most phone photos.
  const estimatedBase64 = Math.ceil(file.size * 4 / 3);
  if (
    SUPPORTED_MEDIA_TYPES.includes(file.type) &&
    estimatedBase64 <= MAX_BASE64_BYTES
  ) {
    return await blobToBase64(file);
  }

  // Slow path: need to resize or convert. Decode, draw to canvas, re-encode as JPEG,
  // step the quality down until the result fits under the limit.
  const source = await decodeImage(file);

  let width = source.width;
  let height = source.height;
  const longest = Math.max(width, height);
  if (longest > MAX_IMAGE_DIMENSION) {
    const scale = MAX_IMAGE_DIMENSION / longest;
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(source, 0, 0, width, height);

  // Clean up the decoded source.
  if (typeof source.close === 'function') source.close(); // ImageBitmap
  if (source._objectUrl) URL.revokeObjectURL(source._objectUrl); // <img> fallback

  for (const quality of [0.85, 0.75, 0.65, 0.55, 0.45, 0.35]) {
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
    if (!blob) continue;
    const encoded = await blobToBase64(blob);
    if (encoded.data.length <= MAX_BASE64_BYTES) return encoded;
  }

  const fallback = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.3));
  return await blobToBase64(fallback);
}

// ======================== 3. API wrappers ========================

async function callAnthropic({ apiKey, systemPrompt, userContent }) {
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
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`API error ${response.status}: ${errText}`);
  }

  const result = await response.json();
  const textBlock = (result.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Claude returned no text response.');

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

async function suggestLots({ apiKey, images, targetLotCount, fuzzy, itemCategory }) {
  if (!apiKey) throw new Error('No API key provided.');
  if (!images || images.length === 0) throw new Error('At least one photo is required.');

  const imageBlocks = await Promise.all(
    images.map(async (img) => {
      const { data, mediaType } = await compressImage(img);
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
    })
  );

  // Prepend a text label before each image so Claude can tag items with their source.
  const userContent = [];
  imageBlocks.forEach((block, idx) => {
    userContent.push({ type: 'text', text: `Photo ${idx + 1}:` });
    userContent.push(block);
  });

  const countInstruction = fuzzy
    ? `Aim for about ${targetLotCount} lots, but deviate up or down if that produces more coherent groupings.`
    : `Produce exactly ${targetLotCount} lots.`;
  const categoryHint = itemCategory ? `The items in these photos are primarily ${itemCategory}.` : '';

  userContent.push({
    type: 'text',
    text: `${categoryHint}\n\n${countInstruction}\n\nIdentify all items and return JSON.`.trim()
  });

  return await callAnthropic({ apiKey, systemPrompt: INITIAL_SYSTEM_PROMPT, userContent });
}

async function assignStragglers({ apiKey, currentResult, newImages, stragglerText, itemCategory }) {
  const imageBlocks = await Promise.all(
    newImages.map(async (img) => {
      const { data, mediaType } = await compressImage(img);
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
    })
  );

  // Strip lot_number (client-side bookkeeping) before sending to Claude.
  const existingLotsForModel = (currentResult.lots || []).map((l) => ({
    id: l.id,
    title: l.title,
    short_title: l.short_title,
    theme: l.theme,
    item_ids: l.item_ids
  }));

  const context = {
    existing_items: currentResult.items || [],
    existing_lots: existingLotsForModel
  };

  const userContent = [
    {
      type: 'text',
      text: `Current lot organization (DO NOT modify existing item_ids; only add new items to them):\n\n${JSON.stringify(context, null, 2)}\n\nNew items to integrate follow.`
    }
  ];

  imageBlocks.forEach((block, idx) => {
    userContent.push({ type: 'text', text: `Straggler photo ${idx + 1}:` });
    userContent.push(block);
  });

  if (stragglerText && stragglerText.trim()) {
    userContent.push({
      type: 'text',
      text: `Text descriptions of straggler items (source = "Straggler text"), one per line:\n\n${stragglerText.trim()}`
    });
  }

  const categoryHint = itemCategory ? `The items are primarily ${itemCategory}. ` : '';
  userContent.push({
    type: 'text',
    text: `${categoryHint}Integrate these new items. Prefer adding to existing lots; only create new lots if truly necessary. Return JSON.`
  });

  return await callAnthropic({ apiKey, systemPrompt: STRAGGLERS_SYSTEM_PROMPT, userContent });
}

async function reassignDissolvedItems({ apiKey, remainingLots, itemsToReassign, itemCategory }) {
  const context = {
    remaining_lots: remainingLots.map((l) => ({
      id: l.id,
      title: l.title,
      theme: l.theme,
      item_ids: l.item_ids
    })),
    items_to_reassign: itemsToReassign.map((it) => ({
      id: it.id,
      name: it.name,
      source: it.source,
      notes: it.notes
    }))
  };

  const categoryHint = itemCategory ? ` Items are primarily ${itemCategory}.` : '';
  const userContent = [
    {
      type: 'text',
      text: `Assign each item in "items_to_reassign" to one of the "remaining_lots". Do not create new lots.${categoryHint}\n\n${JSON.stringify(context, null, 2)}\n\nReturn JSON with "assignments" list.`
    }
  ];

  return await callAnthropic({ apiKey, systemPrompt: DISSOLVE_SYSTEM_PROMPT, userContent });
}

// ======================== 4. Merge helpers ========================

// Attach a stable lot_number to each lot (client-side bookkeeping).
function assignInitialLotNumbers(result) {
  const lots = (result.lots || []).map((lot, idx) => ({ ...lot, lot_number: idx + 1 }));
  return { ...result, lots };
}

// When merging new_lots from stragglers, continue numbering from the current max.
function nextLotNumber(result) {
  const nums = (result.lots || []).map((l) => l.lot_number || 0);
  return (nums.length > 0 ? Math.max(...nums) : 0) + 1;
}

function mergeStragglers(result, additions) {
  const items = [...(result.items || []), ...(additions.new_items || [])];

  // Add new items to existing lots per assignments.
  let lots = (result.lots || []).map((lot) => {
    const assignment = (additions.assignments || []).find((a) => a.lot_id === lot.id);
    if (!assignment) return lot;
    return { ...lot, item_ids: [...lot.item_ids, ...assignment.item_ids] };
  });

  // Append genuinely new lots with fresh lot_numbers.
  let next = nextLotNumber({ lots });
  const newLots = (additions.new_lots || []).map((lot) => {
    const withNumber = { ...lot, lot_number: next++ };
    return withNumber;
  });
  lots = [...lots, ...newLots];

  const unassigned = [...(result.unassigned_item_ids || []), ...(additions.unassigned_item_ids || [])];
  const notRecommended = [...(result.not_recommended || []), ...(additions.not_recommended || [])];

  return {
    ...result,
    items,
    lots,
    unassigned_item_ids: unassigned,
    not_recommended: notRecommended
  };
}

// After dissolve: remove the dissolved lot, then add its items to their new lots per assignments.
function applyDissolveResult(resultWithoutLot, response) {
  const lots = (resultWithoutLot.lots || []).map((lot) => {
    const assignment = (response.assignments || []).find((a) => a.lot_id === lot.id);
    if (!assignment) return lot;
    return { ...lot, item_ids: [...lot.item_ids, ...assignment.item_ids] };
  });
  const unassigned = [
    ...(resultWithoutLot.unassigned_item_ids || []),
    ...(response.unassigned_item_ids || [])
  ];
  return { ...resultWithoutLot, lots, unassigned_item_ids: unassigned };
}

// ======================== 5. UI components ========================

function KeyInput({ apiKey, onChange }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800 p-4">
      <label className="block text-sm font-medium text-slate-300 mb-2">Anthropic API key</label>
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
        <a href="https://console.anthropic.com" target="_blank" rel="noreferrer" className="underline">console.anthropic.com</a>.
      </p>
    </div>
  );
}

function PhotoUpload({ images, onChange, label }) {
  const cameraRef = useRef(null);
  const galleryRef = useRef(null);

  function handleFiles(e) {
    const files = Array.from(e.target.files || []);
    onChange([...images, ...files]);
    e.target.value = '';
  }

  function removeAt(idx) {
    onChange(images.filter((_, i) => i !== idx));
  }

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800 p-4">
      <label className="block text-sm font-medium text-slate-300 mb-2">
        {label || 'Photos'} ({images.length})
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

      {/* Two hidden inputs: one with capture (forces camera), one without (opens gallery). */}
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" multiple onChange={handleFiles} className="hidden" />
      <input ref={galleryRef} type="file" accept="image/*" multiple onChange={handleFiles} className="hidden" />

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => cameraRef.current && cameraRef.current.click()}
          className="rounded bg-indigo-600 hover:bg-indigo-500 py-3 text-sm font-medium"
        >
          Take photo
        </button>
        <button
          type="button"
          onClick={() => galleryRef.current && galleryRef.current.click()}
          className="rounded bg-slate-600 hover:bg-slate-500 py-3 text-sm font-medium"
        >
          From gallery
        </button>
      </div>
    </div>
  );
}

function LotControls({
  targetLotCount, fuzzy, itemCategory,
  onChangeLotCount, onChangeFuzzy, onChangeCategory
}) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800 p-4 space-y-4">
      <div>
        <label className="block text-sm font-medium text-slate-300 mb-2">Target number of lots</label>
        <input
          type="number" min={1} max={50}
          inputMode="numeric"
          value={targetLotCount}
          onChange={(e) => onChangeLotCount(e.target.value)}
          className="w-24 rounded bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-100"
        />
        <label className="inline-flex items-center ml-4 text-sm">
          <input type="checkbox" checked={fuzzy} onChange={(e) => onChangeFuzzy(e.target.checked)} className="mr-2" />
          Fuzzy (prioritize coherent themes over exact count)
        </label>
      </div>
      <div>
        <label className="block text-sm font-medium text-slate-300 mb-2">Item category (optional)</label>
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

// Modal overlay for app settings (currently just the API key).
function SettingsModal({ open, onClose, apiKey, onChangeApiKey }) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50"
      onClick={onClose}
    >
      <div
        className="bg-slate-900 rounded-lg max-w-md w-full p-4 space-y-4 border border-slate-700"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Settings</h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white text-2xl leading-none w-8 h-8 flex items-center justify-center rounded hover:bg-slate-800"
            aria-label="Close settings"
          >
            ×
          </button>
        </div>
        <KeyInput apiKey={apiKey} onChange={onChangeApiKey} />
        <p className="text-xs text-slate-500">
          Stored only in this browser on this device. Sent only to Anthropic's API, never anywhere else.
        </p>
        <button
          onClick={onClose}
          className="w-full rounded bg-slate-700 hover:bg-slate-600 py-2 text-sm font-medium"
        >
          Done
        </button>
      </div>
    </div>
  );
}

// Clickable pill that copies its text to the clipboard on tap.
function CopyPill({ text }) {
  const [copied, setCopied] = useState(false);
  async function handleClick() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('Clipboard copy failed:', err);
    }
  }
  return (
    <button
      onClick={handleClick}
      className="inline-flex items-center gap-1 rounded-full bg-indigo-900/60 hover:bg-indigo-800 border border-indigo-600 px-3 py-1.5 text-xs font-mono text-indigo-100 transition-colors text-left leading-snug"
      title="Tap to copy eBay-ready title"
    >
      <span>{copied ? '✓ Copied!' : text}</span>
    </button>
  );
}

function LotCard({ lot, items, onDissolve }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800 p-4">
      <div className="flex items-start justify-between mb-2 gap-2">
        <h3 className="text-lg font-semibold text-indigo-300">
          <span className="text-slate-400 mr-1">Lot {lot.lot_number}:</span>
          {lot.title}
        </h3>
        <button
          onClick={onDissolve}
          className="shrink-0 text-xs rounded bg-slate-700 hover:bg-red-700 px-2 py-1"
          title="Dissolve this lot and reassign its items to other lots"
        >
          Dissolve
        </button>
      </div>

      <p className="text-sm text-slate-400 italic mb-3">{lot.theme}</p>

      {lot.short_title && (
        <div className="mb-3">
          <CopyPill text={lot.short_title} />
        </div>
      )}

      <ul className="list-disc list-inside space-y-1 text-sm">
        {lot.item_ids.map((iid) => {
          const item = items.find((i) => i.id === iid);
          if (!item) return null;
          return (
            <li key={iid}>
              <span className="font-medium">{item.name}</span>
              {item.source && <span className="text-slate-500 text-xs ml-1">[{item.source}]</span>}
              {item.notes && <span className="text-slate-400"> — {item.notes}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Lists every item grouped by source photo, with its lot number. For sorting physical items.
function SortingView({ result }) {
  if (!result || !result.items || result.items.length === 0) return null;

  const lotByItemId = {};
  (result.lots || []).forEach((lot) => {
    (lot.item_ids || []).forEach((iid) => { lotByItemId[iid] = lot.lot_number; });
  });

  const notRecommendedIds = new Set((result.not_recommended || []).map((e) => e.item_id));

  const bySource = {};
  result.items.forEach((item) => {
    const src = item.source || 'Unknown source';
    if (!bySource[src]) bySource[src] = [];
    bySource[src].push(item);
  });

  const sourceOrder = Object.keys(bySource).sort((a, b) => {
    const isPhoto = (s) => /^Photo \d+/.test(s);
    const isStragglerPhoto = (s) => /^Straggler photo \d+/.test(s);
    const num = (s) => parseInt(s.match(/\d+/)?.[0] || '999', 10);
    if (isPhoto(a) && isPhoto(b)) return num(a) - num(b);
    if (isPhoto(a)) return -1;
    if (isPhoto(b)) return 1;
    if (isStragglerPhoto(a) && isStragglerPhoto(b)) return num(a) - num(b);
    if (isStragglerPhoto(a)) return -1;
    if (isStragglerPhoto(b)) return 1;
    return a.localeCompare(b);
  });

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800 p-4">
      <h3 className="text-lg font-semibold text-slate-200 mb-1">Sorting guide</h3>
      <p className="text-xs text-slate-400 mb-3">
        Every item grouped by source photo, with its lot number. Use this to sort physical items into labeled piles.
      </p>
      {sourceOrder.map((src) => (
        <div key={src} className="mb-4 last:mb-0">
          <h4 className="text-sm font-semibold text-slate-300 mb-1 border-b border-slate-700 pb-1">{src}</h4>
          <ul>
            {bySource[src].map((item) => {
              const lotNum = lotByItemId[item.id];
              const isNR = notRecommendedIds.has(item.id);
              return (
                <li key={item.id} className="text-sm flex justify-between gap-3 py-1 border-b border-slate-700/30 last:border-b-0">
                  <span>{item.name}</span>
                  <span className={`shrink-0 font-mono text-xs whitespace-nowrap ${
                    lotNum ? 'text-emerald-400' : isNR ? 'text-slate-500' : 'text-amber-400'
                  }`}>
                    {lotNum ? `→ Lot ${lotNum}` : isNR ? '— not recommended' : '— unassigned'}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function UnassignedView({ result }) {
  const unassigned = result?.unassigned_item_ids || [];
  const items = result?.items || [];
  if (unassigned.length === 0) return null;
  return (
    <div className="rounded-lg border border-amber-700 bg-amber-900/30 p-4">
      <h3 className="text-lg font-semibold text-amber-300 mb-2">Unassigned items</h3>
      <ul className="list-disc list-inside space-y-1 text-sm">
        {unassigned.map((iid) => {
          const item = items.find((i) => i.id === iid);
          return item ? <li key={iid}>{item.name}</li> : null;
        })}
      </ul>
    </div>
  );
}

function NotRecommendedView({ result }) {
  const items = result?.items || [];
  const nr = result?.not_recommended || [];
  if (nr.length === 0) return null;
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-4">
      <h3 className="text-sm font-semibold text-slate-400 mb-2">Not recommended for inclusion in a lot</h3>
      <ul className="space-y-1 text-sm">
        {nr.map((entry) => {
          const item = items.find((i) => i.id === entry.item_id);
          if (!item) return null;
          return (
            <li key={entry.item_id} className="text-slate-400">
              <span className="font-medium text-slate-300">{item.name}</span> — {entry.reason}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function StragglerForm({ onSubmit, loading }) {
  const [mode, setMode] = useState('photo'); // 'photo' | 'text'
  const [images, setImages] = useState([]);
  const [text, setText] = useState('');

  function handleSubmit() {
    if (mode === 'photo' && images.length === 0) return;
    if (mode === 'text' && !text.trim()) return;
    onSubmit({
      newImages: mode === 'photo' ? images : [],
      stragglerText: mode === 'text' ? text : ''
    });
    setImages([]);
    setText('');
  }

  const canSubmit = !loading && (
    (mode === 'photo' && images.length > 0) ||
    (mode === 'text' && text.trim())
  );

  return (
    <div className="rounded-lg border border-slate-600 bg-slate-900 p-4 space-y-3">
      <h3 className="text-lg font-semibold text-slate-200">Add stragglers</h3>
      <p className="text-xs text-slate-400">
        For items Claude missed or misidentified. Stragglers are added to existing lots where they fit;
        new lots are created only if truly necessary. Existing assignments are not changed.
      </p>

      <div className="flex gap-2 text-sm">
        <button
          onClick={() => setMode('photo')}
          className={`px-3 py-1 rounded ${mode === 'photo' ? 'bg-indigo-700' : 'bg-slate-700 hover:bg-slate-600'}`}
        >
          Photo
        </button>
        <button
          onClick={() => setMode('text')}
          className={`px-3 py-1 rounded ${mode === 'text' ? 'bg-indigo-700' : 'bg-slate-700 hover:bg-slate-600'}`}
        >
          Text
        </button>
      </div>

      {mode === 'photo' ? (
        <PhotoUpload images={images} onChange={setImages} label="Straggler photos" />
      ) : (
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'One item per line, e.g.:\nRolling Stones - Let It Bleed CD\nJohn Mayer - Battle Studies\n...'}
          rows={5}
          className="w-full rounded bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-100"
        />
      )}

      <button
        onClick={handleSubmit}
        disabled={!canSubmit}
        className="w-full rounded bg-emerald-700 hover:bg-emerald-600 disabled:bg-slate-700 disabled:text-slate-500 py-2 font-medium"
      >
        {loading ? 'Working…' : 'Add stragglers'}
      </button>
    </div>
  );
}

function LotsView({ result, onDissolve }) {
  if (!result) return null;
  return (
    <div className="space-y-4">
      {(result.lots || []).map((lot) => (
        <LotCard
          key={lot.id}
          lot={lot}
          items={result.items || []}
          onDissolve={() => onDissolve(lot.id)}
        />
      ))}
      <SortingView result={result} />
      <UnassignedView result={result} />
      <NotRecommendedView result={result} />
      {result.notes_to_seller && (
        <div className="rounded-lg border border-slate-700 bg-slate-800 p-4">
          <h3 className="text-sm font-semibold text-slate-300 mb-1">Notes</h3>
          <p className="text-sm text-slate-300">{result.notes_to_seller}</p>
        </div>
      )}
    </div>
  );
}

// ======================== 6. App ========================

function App() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(LS_API_KEY) || '');
  const [images, setImages] = useState([]);
  // Keep lot count as a STRING so the input can be cleared cleanly (no phantom "0"
  // appearing when the user deletes the value to type a new one). Convert to a number
  // where we actually need the numeric value.
  const [targetLotCountStr, setTargetLotCountStr] = useState('5');
  const targetLotCount = parseInt(targetLotCountStr, 10) || 0;
  const [fuzzy, setFuzzy] = useState(true);
  const [itemCategory, setItemCategory] = useState(() => localStorage.getItem(LS_CATEGORY) || '');

  const [loading, setLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  // Settings modal visibility. Auto-open on first load if no key has ever been saved.
  const [showSettings, setShowSettings] = useState(() => !localStorage.getItem(LS_API_KEY));

  useEffect(() => { localStorage.setItem(LS_API_KEY, apiKey); }, [apiKey]);
  useEffect(() => { localStorage.setItem(LS_CATEGORY, itemCategory); }, [itemCategory]);

  function handleStartOver() {
    if (!window.confirm('Clear the current batch and start over? (Your API key and category will be kept.)')) return;
    setImages([]);
    setResult(null);
    setError('');
  }

  async function handleSubmit() {
    setError('');
    setResult(null);
    setLoading(true);
    setLoadingMessage('Analyzing photos…');
    try {
      const raw = await suggestLots({ apiKey, images, targetLotCount, fuzzy, itemCategory });
      setResult(assignInitialLotNumbers(raw));
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
      setLoadingMessage('');
    }
  }

  async function handleAddStragglers({ newImages, stragglerText }) {
    if (!result) return;
    setError('');
    setLoading(true);
    setLoadingMessage('Placing stragglers…');
    try {
      const additions = await assignStragglers({
        apiKey, currentResult: result, newImages, stragglerText, itemCategory
      });
      setResult(mergeStragglers(result, additions));
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
      setLoadingMessage('');
    }
  }

  async function handleDissolveLot(lotId) {
    if (!result) return;
    const dissolved = result.lots.find((l) => l.id === lotId);
    if (!dissolved) return;
    if (!window.confirm(`Dissolve "Lot ${dissolved.lot_number}: ${dissolved.title}" and reassign its ${dissolved.item_ids.length} item(s) to other lots?`)) return;

    const itemsToReassign = dissolved.item_ids
      .map((iid) => (result.items || []).find((i) => i.id === iid))
      .filter(Boolean);

    const resultWithoutLot = {
      ...result,
      lots: result.lots.filter((l) => l.id !== lotId)
    };

    setError('');
    setLoading(true);
    setLoadingMessage('Reassigning items…');
    try {
      const response = await reassignDissolvedItems({
        apiKey,
        remainingLots: resultWithoutLot.lots,
        itemsToReassign,
        itemCategory
      });
      setResult(applyDissolveResult(resultWithoutLot, response));
    } catch (err) {
      setError(err.message || String(err));
      // Restore original result on failure so we don't lose the dissolved lot.
      setResult(result);
    } finally {
      setLoading(false);
      setLoadingMessage('');
    }
  }

  const canSubmit = apiKey && images.length > 0 && !loading && targetLotCount > 0;
  const canStartOver = !loading && (images.length > 0 || result);

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4">
      <header className="py-4 flex items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">Lot Suggestion Tool</h1>
          <p className="text-sm text-slate-400">
            Photograph a batch of items. Claude groups them into themed lots for eBay.
          </p>
        </div>
        <button
          onClick={() => setShowSettings(true)}
          className="shrink-0 rounded p-2 text-xl hover:bg-slate-800"
          aria-label="Settings"
          title="Settings"
        >
          ⚙
        </button>
      </header>

      {!apiKey && (
        <div className="rounded border border-amber-700 bg-amber-900/30 p-3 text-sm text-amber-200">
          No API key set. Tap the gear icon to add one before running.
        </div>
      )}

      <PhotoUpload images={images} onChange={setImages} label="Photos" />
      <LotControls
        targetLotCount={targetLotCountStr}
        fuzzy={fuzzy}
        itemCategory={itemCategory}
        onChangeLotCount={setTargetLotCountStr}
        onChangeFuzzy={setFuzzy}
        onChangeCategory={setItemCategory}
      />

      <button
        onClick={handleSubmit}
        disabled={!canSubmit}
        className="w-full rounded bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-500 py-3 font-medium"
      >
        {loading && !result ? (loadingMessage || 'Thinking…') : 'Suggest lots'}
      </button>

      {canStartOver && (
        <button
          onClick={handleStartOver}
          className="w-full rounded border border-slate-600 hover:border-red-600 hover:text-red-300 py-2 text-sm text-slate-400"
        >
          Start over
        </button>
      )}

      {error && (
        <div className="rounded border border-red-700 bg-red-900/40 p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {result && (
        <>
          <LotsView result={result} onDissolve={handleDissolveLot} />
          <StragglerForm onSubmit={handleAddStragglers} loading={loading} />
          {loading && (
            <div className="rounded border border-slate-700 bg-slate-800 p-3 text-sm text-slate-300 text-center">
              {loadingMessage || 'Working…'}
            </div>
          )}
        </>
      )}

      <footer className="text-xs text-slate-500 text-center py-6">
        Your API key stays on this device. Calls go directly to Anthropic.
      </footer>

      <SettingsModal
        open={showSettings}
        onClose={() => setShowSettings(false)}
        apiKey={apiKey}
        onChangeApiKey={setApiKey}
      />
    </div>
  );
}

// ======================== 7. Mount ========================

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
