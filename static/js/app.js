const messagesEl = document.getElementById('messages');
const form = document.getElementById('chat-form');
const input = document.getElementById('chat-input');
const resetBtn = document.getElementById('reset-btn');
const sendBtn = document.getElementById('send-btn');
const modelNameEl = document.getElementById('model-name');
const themeToggle = document.getElementById('theme-toggle');

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  themeToggle.textContent = theme === 'light' ? '☀️' : '🌙';
}

applyTheme(document.documentElement.getAttribute('data-theme'));

themeToggle.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  localStorage.setItem('theme', next);
  applyTheme(next);
});

let isStreaming = false;
let currentController = null;
const contextInfoEl = document.getElementById('context-info');
const ollamaBanner = document.getElementById('ollama-banner');

function updateContextInfo(tokens, limit) {
  contextInfoEl.textContent = `${tokens.toLocaleString()} / ${limit.toLocaleString()} ctx`;
}

function updateOllamaBanner(error) {
  ollamaBanner.textContent = error ? `⚠️ ${error}` : '';
  ollamaBanner.hidden = !error;
}

fetch('/api/context')
  .then((r) => r.json())
  .then(({ tokens, limit }) => updateContextInfo(tokens, limit));

const settingsBtn = document.getElementById('settings-btn');
const settingsDialog = document.getElementById('settings-dialog');
const settingsForm = document.getElementById('settings-form');
const settingsCancel = document.getElementById('settings-cancel');
const settingsDefaults = document.getElementById('settings-defaults');
const modelSelect = settingsForm.elements.model_name;
const numPredictInput = settingsForm.elements.num_predict;
const unlimitedTokensCheckbox = document.getElementById('unlimited-tokens');
const webSearchToggle = document.getElementById('web-search-toggle');

unlimitedTokensCheckbox.addEventListener('change', () => {
  if (unlimitedTokensCheckbox.checked) {
    numPredictInput.dataset.previousValue = numPredictInput.value;
    numPredictInput.value = -1;
    numPredictInput.readOnly = true;
  } else {
    numPredictInput.readOnly = false;
    numPredictInput.value = numPredictInput.dataset.previousValue || 2048;
  }
});

const attachBtn = document.getElementById('attach-btn');
const attachInput = document.getElementById('attach-input');
const attachmentPreviews = document.getElementById('attachment-previews');
const pendingImages = [];

fetch('/api/web-search')
  .then((r) => r.json())
  .then(({ enabled }) => { webSearchToggle.checked = enabled; });

webSearchToggle.addEventListener('change', () => {
  fetch('/api/web-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: webSearchToggle.checked }),
  });
});

marked.setOptions({ breaks: true });

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' });

let mermaidCounter = 0;

async function renderMermaidDiagrams(container) {
  const blocks = container.querySelectorAll('pre > code.language-mermaid');

  for (const codeEl of blocks) {
    const code = codeEl.textContent;
    const pre = codeEl.parentElement;

    try {
      const { svg } = await mermaid.render(`mermaid-${mermaidCounter++}`, code);
      const wrapper = document.createElement('div');
      wrapper.className = 'mermaid-diagram';
      wrapper.innerHTML = svg;
      pre.replaceWith(wrapper);
    } catch (err) {
      const note = document.createElement('div');
      note.className = 'stats truncated';
      note.textContent = `⚠️ Diagram failed to render: ${err.message}`;
      pre.after(note);
    }
  }
}

const NUMERIC_SETTINGS = ['temperature', 'top_p', 'top_k', 'repeat_penalty', 'num_ctx', 'num_predict'];

function updateRangeLabels() {
  settingsForm.querySelectorAll('input[type="range"]').forEach((rangeInput) => {
    const label = settingsForm.querySelector(`[data-value-for="${rangeInput.name}"]`);
    if (label) label.textContent = rangeInput.value;
  });
}

async function populateModelOptions(selected) {
  const response = await fetch('/api/models');
  let { models, error } = await response.json();
  updateOllamaBanner(error);

  if (selected && !models.includes(selected)) models = [selected, ...models];

  modelSelect.innerHTML = '';
  for (const name of models) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    modelSelect.appendChild(option);
  }

  modelSelect.value = selected;
}

function applySettingsToForm(settings) {
  for (const [key, value] of Object.entries(settings)) {
    if (key === 'model_name') continue;
    const field = settingsForm.elements[key];
    if (field) field.value = value;
  }
  updateRangeLabels();

  const isUnlimited = Number(settings.num_predict) < 0;
  unlimitedTokensCheckbox.checked = isUnlimited;
  numPredictInput.readOnly = isUnlimited;
}

async function openSettings() {
  const response = await fetch('/api/settings');
  const settings = await response.json();

  await populateModelOptions(settings.model_name);
  applySettingsToForm(settings);

  settingsDialog.showModal();
}

settingsBtn.addEventListener('click', openSettings);
settingsCancel.addEventListener('click', () => settingsDialog.close());

settingsDefaults.addEventListener('click', async () => {
  const response = await fetch('/api/settings/reset', { method: 'POST' });
  const settings = await response.json();

  await populateModelOptions(settings.model_name);
  applySettingsToForm(settings);

  modelNameEl.textContent = settings.model_name;
  messagesEl.innerHTML = '';
  updateContextInfo(0, settings.num_ctx);
});

settingsForm.querySelectorAll('input[type="range"]').forEach((rangeInput) => {
  rangeInput.addEventListener('input', updateRangeLabels);
});

settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const formData = new FormData(settingsForm);
  const payload = {};
  for (const [key, value] of formData.entries()) {
    payload[key] = NUMERIC_SETTINGS.includes(key) ? Number(value) : value;
  }

  const response = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    alert('Failed to save settings.');
    return;
  }

  const settings = await response.json();
  modelNameEl.textContent = settings.model_name;
  messagesEl.innerHTML = '';
  updateContextInfo(0, settings.num_ctx);
  settingsDialog.close();
});

function addMessage(role) {
  const wrapper = document.createElement('div');
  wrapper.className = `message ${role}`;

  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = role === 'user' ? 'You' : 'AI';
  wrapper.appendChild(label);

  const body = document.createElement('div');
  body.className = 'body';
  wrapper.appendChild(body);

  messagesEl.appendChild(wrapper);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return body;
}

function renderMarkdown(el, text) {
  const html = marked.parse(text);
  el.innerHTML = DOMPurify.sanitize(html);
}

async function sendMessage(text) {
  const images = pendingImages.splice(0, pendingImages.length);
  attachmentPreviews.innerHTML = '';

  const userBody = addMessage('user');
  userBody.textContent = text;
  for (const { dataUrl } of images) {
    const thumb = document.createElement('img');
    thumb.className = 'message-image';
    thumb.src = dataUrl;
    userBody.appendChild(thumb);
  }

  const aiBody = addMessage('ai');

  const thinkingEl = document.createElement('details');
  thinkingEl.className = 'thinking';
  const summary = document.createElement('summary');
  summary.textContent = 'Thinking...';
  thinkingEl.appendChild(summary);
  const thinkingText = document.createElement('div');
  thinkingText.className = 'thinking-text';
  thinkingEl.appendChild(thinkingText);
  aiBody.appendChild(thinkingEl);

  let toolLogEl = null;
  const toolEntries = [];

  function ensureToolLog() {
    if (!toolLogEl) {
      toolLogEl = document.createElement('div');
      toolLogEl.className = 'tool-log';
      aiBody.insertBefore(toolLogEl, thinkingEl.nextSibling);
    }
    return toolLogEl;
  }

  const answerEl = document.createElement('div');
  answerEl.className = 'answer';
  aiBody.appendChild(answerEl);

  let thinkingBuffer = '';
  let answerBuffer = '';
  let stopped = false;

  isStreaming = true;
  sendBtn.textContent = 'Stop';
  sendBtn.classList.add('stopping');
  currentController = new AbortController();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, images: images.map((i) => i.base64) }),
      signal: currentController.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`request failed (${response.status})`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split('\n\n');
      buffer = parts.pop();

      for (const part of parts) {
        if (!part.startsWith('data: ')) continue;
        const payload = JSON.parse(part.slice(6));

        if (payload.type === 'thinking') {
          thinkingBuffer += payload.text;
          thinkingText.textContent = thinkingBuffer;
        } else if (payload.type === 'content') {
          answerBuffer += payload.text;
          renderMarkdown(answerEl, answerBuffer);
        } else if (payload.type === 'tool_call') {
          const entry = document.createElement('div');
          entry.className = 'tool-entry';
          entry.textContent = `🔍 ${payload.name}(${JSON.stringify(payload.arguments)})`;
          ensureToolLog().appendChild(entry);
          toolEntries.push(entry);
        } else if (payload.type === 'tool_result') {
          const entry = toolEntries.shift();
          if (entry) entry.textContent += ' — done';
        } else if (payload.type === 'stats') {
          const statsEl = document.createElement('div');
          statsEl.className = 'stats';
          statsEl.textContent = `${payload.tokens_per_second} tok/s · ${payload.tokens} tokens`;
          if (payload.truncated) {
            statsEl.textContent += ' · ⚠️ cut off (hit max output tokens)';
            statsEl.classList.add('truncated');
          }
          aiBody.appendChild(statsEl);
          updateContextInfo(payload.context_tokens, payload.context_limit);
        } else if (payload.type === 'error') {
          answerEl.textContent = `Error: ${payload.text}`;
        }
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      stopped = true;
    } else {
      answerEl.textContent = `Error: ${err.message}`;
    }
  } finally {
    isStreaming = false;
    sendBtn.textContent = 'Send';
    sendBtn.classList.remove('stopping');
    currentController = null;
  }

  if (!thinkingBuffer) {
    thinkingEl.remove();
  } else {
    summary.textContent = 'Thinking';
  }

  await renderMermaidDiagrams(answerEl);

  if (stopped) {
    const stoppedEl = document.createElement('div');
    stoppedEl.className = 'stats';
    stoppedEl.textContent = '⏹ stopped';
    aiBody.appendChild(stoppedEl);
  }

  if (answerBuffer.trim()) {
    aiBody.appendChild(createSpeakButton(answerEl.textContent));
  }
}

let speakingBtn = null;
let currentAudio = null;

function stopSpeaking() {
  window.speechSynthesis.cancel();
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (speakingBtn) {
    speakingBtn.textContent = '🔊';
    speakingBtn.classList.remove('speaking');
    speakingBtn = null;
  }
}

function createSpeakButton(text) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'speak-btn';
  btn.textContent = '🔊';
  btn.title = 'Read aloud';

  btn.addEventListener('click', async () => {
    const wasSpeakingThis = speakingBtn === btn;
    stopSpeaking();
    if (wasSpeakingThis) return;

    speakingBtn = btn;
    btn.textContent = '⏹';
    btn.classList.add('speaking');

    const { tts_engine } = await (await fetch('/api/settings')).json();

    if (tts_engine === 'kokoro') {
      try {
        const response = await fetch('/api/speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        if (!response.ok) throw new Error(`request failed (${response.status})`);

        const blob = await response.blob();
        if (speakingBtn !== btn) return; // stopped while generating

        currentAudio = new Audio(URL.createObjectURL(blob));
        currentAudio.onended = stopSpeaking;
        currentAudio.onerror = stopSpeaking;
        currentAudio.play();
      } catch (err) {
        alert(`Speech generation failed: ${err.message}`);
        stopSpeaking();
      }
    } else {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.onend = stopSpeaking;
      utterance.onerror = stopSpeaking;
      window.speechSynthesis.speak(utterance);
    }
  });

  return btn;
}

form.addEventListener('submit', (e) => {
  e.preventDefault();

  if (isStreaming) {
    currentController?.abort();
    fetch('/api/chat/cancel', { method: 'POST' });
    return;
  }

  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  sendMessage(text);
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

resetBtn.addEventListener('click', async () => {
  await fetch('/api/reset', { method: 'POST' });
  messagesEl.innerHTML = '';
  const { tokens, limit } = await (await fetch('/api/context')).json();
  updateContextInfo(tokens, limit);
});

const micBtn = document.getElementById('mic-btn');
let mediaRecorder = null;
let audioChunks = [];
let recording = false;

async function startRecording() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    alert(`Microphone access failed: ${err.message}`);
    return;
  }

  audioChunks = [];
  mediaRecorder = new MediaRecorder(stream);

  mediaRecorder.addEventListener('dataavailable', (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  });

  mediaRecorder.addEventListener('stop', () => {
    stream.getTracks().forEach((track) => track.stop());
    const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
    transcribeAndInsert(blob);
  });

  mediaRecorder.start();
  recording = true;
  micBtn.classList.add('recording');
  micBtn.textContent = '⏹';
}

function stopRecording() {
  if (mediaRecorder && recording) {
    mediaRecorder.stop();
  }
  recording = false;
  micBtn.classList.remove('recording');
}

async function transcribeAndInsert(blob) {
  micBtn.disabled = true;
  micBtn.textContent = '…';

  const formData = new FormData();
  formData.append('audio', blob, 'recording.webm');

  try {
    const response = await fetch('/api/transcribe', { method: 'POST', body: formData });
    if (!response.ok) throw new Error(`request failed (${response.status})`);

    const { text } = await response.json();
    if (text) {
      input.value = input.value ? `${input.value} ${text}` : text;
      input.focus();
    }
  } catch (err) {
    alert(`Transcription failed: ${err.message}`);
  } finally {
    micBtn.disabled = false;
    micBtn.textContent = '🎤';
  }
}

micBtn.addEventListener('click', () => {
  if (recording) {
    stopRecording();
  } else {
    startRecording();
  }
});

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp)$/i;

function addImagePreview(dataUrl) {
  const entry = { base64: dataUrl.split(',')[1], dataUrl };
  pendingImages.push(entry);

  const chip = document.createElement('div');
  chip.className = 'attachment-chip';

  const thumb = document.createElement('img');
  thumb.src = dataUrl;
  chip.appendChild(thumb);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => {
    const index = pendingImages.indexOf(entry);
    if (index !== -1) pendingImages.splice(index, 1);
    chip.remove();
  });
  chip.appendChild(removeBtn);

  attachmentPreviews.appendChild(chip);
}

async function warnIfNoVision() {
  const settingsResponse = await fetch('/api/settings');
  const { model_name } = await settingsResponse.json();

  const visionResponse = await fetch(`/api/models/vision?model=${encodeURIComponent(model_name)}`);
  const { vision, error } = await visionResponse.json();

  if (error) {
    alert(`Could not check "${model_name}" for image support: ${error}`);
  } else if (!vision) {
    alert(`"${model_name}" doesn't support image input. Pick a vision-capable model in Settings (e.g. gemma4:26b, gemma4:12b, gemma4:e4b).`);
  }
}

async function handleImageFile(file) {
  await warnIfNoVision();

  const reader = new FileReader();
  reader.onload = () => addImagePreview(reader.result);
  reader.readAsDataURL(file);
}

async function handleDocumentFile(file) {
  const formData = new FormData();
  formData.append('document', file);

  try {
    const response = await fetch('/api/extract-document', { method: 'POST', body: formData });
    if (!response.ok) throw new Error(`request failed (${response.status})`);

    const { filename, text } = await response.json();
    const block = `[Attached document: ${filename}]\n${text}\n`;
    input.value = input.value ? `${input.value}\n\n${block}` : block;
    input.focus();
  } catch (err) {
    alert(`Document extraction failed: ${err.message}`);
  }
}

attachBtn.addEventListener('click', () => attachInput.click());

attachInput.addEventListener('change', () => {
  for (const file of attachInput.files) {
    if (IMAGE_EXTENSIONS.test(file.name)) {
      handleImageFile(file);
    } else {
      handleDocumentFile(file);
    }
  }
  attachInput.value = '';
});

// Surface "Ollama not running" / "no models pulled" as a banner right away,
// instead of only after the user opens Settings or sends a message.
populateModelOptions(modelNameEl.textContent);
