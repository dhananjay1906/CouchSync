const msg = document.getElementById('msg');
const preview = document.getElementById('preview');

async function request() {
  msg.className = '';
  msg.textContent = 'Waiting for you to click "Allow" in Chrome\'s popup…';
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (e) {
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch {}
    if (!stream) {
      msg.className = 'bad';
      msg.innerHTML = e.name === 'NotAllowedError'
        ? 'Permission was blocked. Click the camera icon at the right of the address bar → <b>Always allow</b>, then press the button again. Or open <code>chrome://settings/content/camera</code>.'
        : e.name === 'NotReadableError'
          ? 'Your camera is being used by another app (Zoom, Teams, FaceTime…). Close it and try again.'
          : e.name === 'NotFoundError' ? 'No camera or microphone was found.' : `Couldn't start: ${e.name}`;
      return;
    }
  }
  preview.hidden = false;
  preview.srcObject = stream;
  msg.className = 'ok';
  msg.textContent = '✓ All set! This tab will close in a moment — head back to the party.';
  chrome.runtime.sendMessage({ panel: 'media-granted' }).catch(() => {});
  setTimeout(() => {
    stream.getTracks().forEach(t => t.stop());
    window.close();
  }, 2500);
}

document.getElementById('go').addEventListener('click', request);
