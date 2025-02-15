const fs = require('fs');
const path = require('path');

const IMAGES_FOLDER = path.join(__dirname, 'dist/thumbs/'); // Folder containing images
const OUTPUT_FOLDER = path.join(__dirname, 'dist/'); // Folder to store generated HTML files
const IMAGES_PER_PAGE = 50;

// Ensure output folder exists
if (!fs.existsSync(OUTPUT_FOLDER)) {
    fs.mkdirSync(OUTPUT_FOLDER);
}

// Read image files from the folder
const images = fs.readdirSync(IMAGES_FOLDER).filter(file => {
    return ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(path.extname(file).toLowerCase());
});

const totalPages = Math.ceil(images.length / IMAGES_PER_PAGE);

function generateHTMLPage(imagesSubset, pageIndex) {
    const prevPage = pageIndex > 1 ? `page${pageIndex - 1}.html` : '';
    const nextPage = pageIndex < totalPages ? `page${pageIndex + 1}.html` : '';

    const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Image Gallery - Page ${pageIndex}</title>
    <style>
        body { font-family: Arial, sans-serif; text-align: center; }
        .gallery { display: grid; grid-template-columns: repeat(6, 1fr); gap: 5px; padding: 5px; }
        .gallery img { width: 100%; height: auto; border-radius: 5px; }
        .pagination { margin-top: 20px; }
        .pagination a { margin: 0 10px; text-decoration: none; color: blue; }
    </style>
</head>
<body>
    <h1>Image Gallery - Page ${pageIndex}</h1>
    <div class="gallery">
        ${imagesSubset.map(img => `<img src="thumbs/${img}" alt="Image">`).join('\n')}
    </div>
    <div class="pagination">
        ${prevPage ? `<a href="${prevPage}">&laquo; Previous</a>` : ''}
        ${nextPage ? `<a href="${nextPage}">Next &raquo;</a>` : ''}
    </div>
</body>
</html>`;

    if (pageIndex == 1) {
        fs.writeFileSync(path.join(OUTPUT_FOLDER, `page${pageIndex}.html`), htmlContent);
        fs.writeFileSync(path.join(OUTPUT_FOLDER, `index.html`), htmlContent); // extra index file
    }
    else
        fs.writeFileSync(path.join(OUTPUT_FOLDER, `page${pageIndex}.html`), htmlContent);
}

// Generate HTML pages
for (let i = 0; i < totalPages; i++) {
    const start = i * IMAGES_PER_PAGE;
    const end = start + IMAGES_PER_PAGE;
    const imagesSubset = images.slice(start, end);
    generateHTMLPage(imagesSubset, i + 1);
}

console.log(`Generated ${totalPages} pages in the "${OUTPUT_FOLDER}" folder.`);
