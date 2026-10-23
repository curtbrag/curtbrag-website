(() => {
  const form = document.getElementById('contact-form') || document.getElementById('ride-form');
  if (!form) return;
  const button = form.querySelector('button[type="submit"]');
  const label = form.querySelector('#submit-text');
  const spinner = form.querySelector('#submit-spinner');
  if (!button || !label || !spinner) return;
  const idleLabel = label.textContent;
  let submitting = false;
  function setSubmitting(value) {
    submitting = value;
    button.disabled = value;
    button.classList.toggle('opacity-70', value);
    button.classList.toggle('cursor-not-allowed', value);
    label.textContent = value ? (form.id === 'ride-form' ? 'Submitting...' : 'Sending...') : idleLabel;
    spinner.classList.toggle('hidden', !value);
  }
  form.addEventListener('submit', (event) => {
    if (event.defaultPrevented) return;
    if (submitting) { event.preventDefault(); return; }
    setSubmitting(true);
  });
  // Browsers preserve disabled controls when restoring a submitted page with Back.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) setSubmitting(false);
  });

  const photo = form.querySelector('#photo');
  const preview = form.querySelector('#image-preview');
  const image = form.querySelector('#preview-img');
  const error = form.querySelector('#file-error');
  const description = form.querySelector('#description');
  const counter = form.querySelector('#char-count');
  let reader;
  let selection = 0;
  function clearPreview() {
    selection += 1;
    if (reader?.readyState === 1) reader.abort();
    reader = undefined;
    preview?.classList.add('hidden');
    image?.removeAttribute('src');
  }
  function showError(message = '') {
    if (!error) return;
    error.textContent = message;
    error.style.display = message ? '' : 'none';
  }
  function updateCounter() {
    if (description && counter) counter.textContent = String(description.value.length);
  }
  description?.addEventListener('input', updateCounter);
  updateCounter();
  if (photo && preview && image && error) {
    photo.addEventListener('change', () => {
      clearPreview();
      showError();
      const file = photo.files?.[0];
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) {
        photo.value = '';
        showError('File size exceeds 10MB. Please choose a smaller image.');
        return;
      }
      if (file.type && !file.type.startsWith('image/')) {
        photo.value = '';
        showError('Please choose an image file.');
        return;
      }
      const current = selection;
      const currentReader = new FileReader();
      reader = currentReader;
      currentReader.onload = () => {
        if (selection !== current) return;
        image.src = String(currentReader.result);
        preview.classList.remove('hidden');
      };
      currentReader.onerror = () => {
        if (selection !== current) return;
        clearPreview();
        photo.value = '';
        showError('This image could not be read. Please choose another image.');
      };
      currentReader.readAsDataURL(file);
    });
  }
  form.addEventListener('reset', () => {
    setSubmitting(false);
    clearPreview();
    showError();
    // Reset values are applied after the reset event finishes.
    setTimeout(updateCounter, 0);
  });
})();
