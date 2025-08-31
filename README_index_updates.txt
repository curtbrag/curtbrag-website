The existing `index.html` file in the root of your website needs a few simple updates.

You can apply these changes manually or with a text editor.

1. **Update the "Add Your Ride" link.**
   Replace the button that currently links to `https://otis.curtbrag.com/addyourride` with a relative link to your new form:

   ```html
   <!-- Before -->
   <a class="btn" href="https://otis.curtbrag.com/addyourride"><i class="fa-solid fa-car-side"></i>Add Your Ride</a>

   <!-- After -->
   <a class="btn" href="addyourride.html"><i class="fa-solid fa-car-side"></i>Add Your Ride</a>
   ```

2. **Update the Shop button.**
   Point the Shop button directly at Snap‑on’s online store instead of the otis tracking slug:

   ```html
   <!-- Before -->
   <a class="btn" href="https://otis.curtbrag.com/curtshop" target="_blank" rel="noopener"><i class="fa-solid fa-shopping-cart"></i>Shop</a>

   <!-- After -->
   <a class="btn" href="https://shop.snapon.com/" target="_blank" rel="noopener"><i class="fa-solid fa-shopping-cart"></i>Shop</a>
   ```

3. **Add a contact form link.**
   In the Contact section at the bottom of the page, add a link to the new contact form page after your phone number:

   ```html
   <!-- Before -->
   <a href="tel:+17814170692">781‑417‑0692</a>

   <!-- After -->
   <a href="tel:+17814170692">781‑417‑0692</a>
   <a href="contact.html">Contact Form</a>
   ```

These changes will ensure visitors can submit cars directly through the site, shop at Snap‑on with the correct affiliate link and contact you via a proper form.