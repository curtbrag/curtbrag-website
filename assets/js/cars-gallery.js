// Dynamically build the cars gallery from a JSON manifest.
fetch('../assets/data/cars_gallery.json')
  .then(resp => {
    if (!resp.ok) throw new Error('Failed to load gallery manifest');
    return resp.json();
  })
  .then(data => {
    const container = document.getElementById('cars-gallery');
    if (!container) return;
    // Ensure data.images exists and is an array
    const images = Array.isArray(data.images) ? data.images : [];
    images.forEach(file => {
      const img = document.createElement('img');
      img.src = `cars/${file}`;
      img.alt = `cars ${file}`;
      img.addEventListener('click', () => {
        window.open(img.src, '_blank');
      });
      container.appendChild(img);
    });
  })
  .catch(err => {
    console.error('Error loading cars gallery:', err);
  });
