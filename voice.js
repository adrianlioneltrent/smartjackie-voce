const status = document.querySelector('#status');
const audio = document.querySelector('#audio');
const form = document.querySelector('#connect');
const code = document.querySelector('#code');
const stopButton = document.querySelector('#stop');
let active;

function stop(message = 'Microfon oprit.') {
  const previous = active;
  active = undefined;
  previous?.abort.abort();
  previous?.mic?.getTracks().forEach(track => track.stop());
  previous?.peer.close();
  audio.srcObject = null;
  form.hidden = false;
  stopButton.hidden = true;
  status.textContent = message;
}

function handleEvent(call, event) {
  switch (event.type) {
    case 'response.created':
      call.responding = true;
      status.textContent = 'Pregătesc răspunsul…';
      break;
    case 'response.done':
      call.responding = false;
      if (call.queued) {
        call.queued = false;
        requestAnswer(call);
      }
      break;
    case 'output_audio_buffer.started':
      call.speaking = true;
      status.textContent = 'Răspund… Poți spune „gata”, „suficient” sau „ascultă”.';
      break;
    case 'output_audio_buffer.stopped':
    case 'output_audio_buffer.cleared':
      call.speaking = false;
      if (!call.responding) status.textContent = 'Te ascult…';
      break;
    case 'input_audio_buffer.speech_started':
      if (call.responding || call.speaking) call.interrupted.add(event.item_id);
      status.textContent = 'Te ascult…';
      break;
    case 'input_audio_buffer.speech_stopped':
      status.textContent = 'Înțeleg ce ai spus…';
      break;
    case 'conversation.item.input_audio_transcription.completed': {
      const words = (event.transcript || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      const interrupted = call.interrupted.delete(event.item_id);
      if (interrupted && /^(gata|suficient|opreste)( te rog)?$/.test(words)) {
        stop('Răspuns oprit. Microfon închis.');
      } else if (interrupted && /^asculta( ma)?( te rog)?$/.test(words)) {
        status.textContent = 'Te ascult…';
      } else if (words) {
        requestAnswer(call);
      } else {
        status.textContent = 'Nu am înțeles. Mai încearcă o dată.';
      }
      break;
    }
    case 'conversation.item.input_audio_transcription.failed':
      call.interrupted.delete(event.item_id);
      status.textContent = 'Nu am înțeles. Mai încearcă o dată.';
      break;
    case 'error':
      status.textContent = 'A apărut o eroare la răspuns. Încearcă din nou.';
      break;
  }
}

function requestAnswer(call) {
  if (call.responding) {
    call.queued = true;
    return;
  }
  if (call.channel.readyState === 'open') {
    call.responding = true;
    call.channel.send(JSON.stringify({ type: 'response.create' }));
  }
}

async function connect(password) {
  if (active || !password) return;
  form.hidden = true;
  stopButton.hidden = false;
  status.textContent = 'Pornesc microfonul…';
  let call;
  try {
    call = { peer: new RTCPeerConnection(), abort: new AbortController(), interrupted: new Set() };
    active = call;
    call.peer.ontrack = event => {
      if (active === call) audio.srcObject = event.streams[0] || new MediaStream([event.track]);
    };
    call.peer.onconnectionstatechange = () => {
      if (active === call && ['failed', 'closed'].includes(call.peer.connectionState)) {
        stop('Conexiunea s-a întrerupt.');
      }
    };
    call.channel = call.peer.createDataChannel('oai-events');
    call.channel.onopen = () => { if (active === call) status.textContent = 'Te ascult…'; };
    call.channel.onmessage = event => { if (active === call) handleEvent(call, JSON.parse(event.data)); };
    call.mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (active !== call) {
      call.mic.getTracks().forEach(track => track.stop());
      return;
    }
    for (const track of call.mic.getAudioTracks()) call.peer.addTrack(track, call.mic);
    await call.peer.setLocalDescription(await call.peer.createOffer());
    status.textContent = 'Mă conectez la OpenAI…';
    const response = await fetch('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp', Authorization: 'Bearer ' + password },
      body: call.peer.localDescription.sdp,
      signal: call.abort.signal,
    });
    if (response.status === 401) {
      localStorage.removeItem('access');
      code.value = '';
      return stop('Cod de acces incorect.');
    }
    if (!response.ok) {
      const message = await response.text();
      const providerStatus = /^OpenAI HTTP \d{3}$/.test(message) ? ' ' + message + '.' : '';
      return stop('Conexiunea vocală nu a pornit.' + providerStatus);
    }
    await call.peer.setRemoteDescription({ type: 'answer', sdp: await response.text() });
    if (active === call) localStorage.setItem('access', password);
  } catch {
    if (active === call) stop('Verifică permisiunea pentru microfon și conexiunea la internet.');
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  connect(code.value.trim());
});
stopButton.addEventListener('click', () => stop());
addEventListener('pagehide', () => stop());
window.stopSmartJackieVoice = stop;
const saved = localStorage.getItem('access');
if (saved) {
  code.value = saved;
  connect(saved);
}
