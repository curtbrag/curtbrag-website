The **Cars Gallery** page in this patch has been converted from a static list of `<img>` tags to a dynamic gallery.

### How it works

- The file `gallery/cars.html` no longer hard‑codes a long list of images. Instead, it loads a JavaScript file (`assets/js/cars-gallery.js`) that reads a manifest at `assets/data/cars_gallery.json`.
- This manifest contains a simple array of image filenames. The script creates `<img>` elements for each filename and inserts them into the gallery grid.
- When you click an image, it opens the full photo in a new tab—just like before.

### Updating the gallery

1. **Add your image files**: Place your car images inside the `gallery/cars/` directory of your site. Make sure the filenames match what you put in the JSON manifest.
2. **Update the manifest**: Open `assets/data/cars_gallery.json` and add or remove filenames in the `images` array as needed. Keep the list in double quotes, separated by commas.
3. **Deploy**: After updating the JSON and adding your photos, redeploy the site. The gallery will update automatically.

You can generate or update the JSON manifest using your preferred scripting language (Node.js, Python, etc.) to scan the `gallery/cars` directory and output a list of filenames. This keeps the gallery easy to maintain even as you add more cars.