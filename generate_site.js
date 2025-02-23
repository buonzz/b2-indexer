const fs = require('fs');
const path = require('path');

require('dotenv').config();

const IMAGES_FOLDER = path.join(__dirname, 'dist/thumbs/'); // Folder containing images
const OUTPUT_FOLDER = path.join(__dirname, 'dist/'); // Folder to store generated HTML files
const IMAGES_PER_PAGE = 50;

// Ensure output folder exists
if (!fs.existsSync(OUTPUT_FOLDER)) {
    fs.mkdirSync(OUTPUT_FOLDER);
}

// Read image files from the folder
const images = fs.readdirSync(IMAGES_FOLDER).filter(file => {
    var extensions = process.env.IMAGE_EXTENSIONS.split(',').map(ext => `.${ext}`);
    return extensions.includes(path.extname(file).toLowerCase());
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
    <title>B2 Indexer Gallery - Page ${pageIndex}</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet" integrity="sha384-QWTKZyjpPEjISv5WaRU9OFeRpok6YctnYmDr5pNlyT2bRjXh0JMhjY6hW+ALEwIH" crossorigin="anonymous">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css">
</head>
<body>
    <div class="container mt-2">
        <div class="row">
            <div class="col-md-12">
                <nav class=" float-end" aria-label="Page navigation example">
                    <ul class="pagination">
                        ${prevPage ? `<li class="page-item"><a class="page-link" href="${prevPage}">&laquo; Previous</a><li>` : ''}
                        <li class="page-item"><a class="page-link" href="index.html">Albums</a><li>
                        ${nextPage ? `<li class="page-item"><a  class="page-link" href="${nextPage}">Next &raquo;</a></li>` : ''}
                    </ul>
                </nav>
            </div>
        </div>
    </div><!-- container -->

    <div class="container">
        <div class="row" id="grid">
            ${imagesSubset.map(img => `<div class="col-sm-6 col-lg-2 mt-2">
                    <div class="card">
                        <img src="thumbs/${img}" class="card-img-top"/>
                         <div class="card-body">
                                <p>${start_and_end(img)}</p>
                                <a href="#" class="download-btn" data-filename="${img}" class="btn btn-secondary btn-sm"><i class="bi bi-download"></i></a>
                         </div><!-- card -->
                    </div><!-- card -->
                </div><!-- col -->`).join('\n')}
          </div><!-- row -->
    </div><!-- container -->

    <div class="container mt-2">
        <div class="row">
            <div class="col-md-12">
                <nav class=" float-end" aria-label="Page navigation example">
                    <ul class="pagination">
                        ${prevPage ? `<li class="page-item"><a class="page-link" href="${prevPage}">&laquo; Previous</a><li>` : ''}
                        ${nextPage ? `<li class="page-item"><a  class="page-link" href="${nextPage}">Next &raquo;</a></li>` : ''}
                    </ul>
                </nav>
            </div>
        </div>
    </div><!-- container -->
    <script src="https://code.jquery.com/jquery-3.5.1.min.js"></script>
    <script src="https://unpkg.com/masonry-layout@4/dist/masonry.pkgd.min.js"></script>
    <script src="https://unpkg.com/imagesloaded@5/imagesloaded.pkgd.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js" integrity="sha384-YvpcrYf0tY3lHB60NNkmXc5s9fDVZLESaAA55NDzOxhy9GkcIdslK1eN7N6jIeHz" crossorigin="anonymous"></script>
    <script>
        var downloadLinks = null;
        $.getJSON("download-links.json", function(data){
            downloadLinks = data;
            //console.log(downloadLinks);
        }).fail(function(){
            console.log("An error has occurred.");
        });
    </script>
    <script src="app.js"></script>
</body>
</html>`;

    if (pageIndex == 1) {
        fs.writeFileSync(path.join(OUTPUT_FOLDER, `page${pageIndex}.html`), htmlContent);
        fs.writeFileSync(path.join(OUTPUT_FOLDER, `all-index.html`), htmlContent); // extra index file
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


function start_and_end(str) {
    if (str.length > 35) {
        return str.substr(0, 20) + '...' + str.substr(str.length - 10, str.length);
    }
    return str;
}