const fs = require('fs');
const path = require('path');
const json = require('big-json');

require('dotenv').config();

const albumsFile = path.join(__dirname, 'dist/' + 'albums.json');
const OUTPUT_FOLDER = path.join(__dirname, 'dist/'); // Folder to store generated HTML files
var albumLinks = [];

// Ensure output folder exists
if (!fs.existsSync(OUTPUT_FOLDER)) {
    fs.mkdirSync(OUTPUT_FOLDER);
}


const readStream = fs.createReadStream(albumsFile);
const parseStream = json.createParseStream();

parseStream.on('data', function (pojo) {

    const totalPages = Object.keys(pojo).length;

    // Generate HTML pages
    var ctr = 1;
    for (var album in pojo) {
        if (Object.prototype.hasOwnProperty.call(pojo, album)) {
            var page = generateHTMLPage(pojo[album], ctr, totalPages, album);
            albumLinks.push(page);
            ctr++;
        }
    }

    albumLinks.push({
        "label": "All",
        "link": "all-index.html"
    });

    generateHomepage(albumLinks);

    console.log(`Generated ${totalPages} pages in the "${OUTPUT_FOLDER}" folder.`);
}); // parsed json

readStream.pipe(parseStream);



function generateHTMLPage(imagesSubset, pageIndex, totalPages, album) {
    const prevPage = pageIndex > 1 ? `albums-page-${pageIndex - 1}.html` : '';
    const nextPage = pageIndex < totalPages ? `albums-page-${pageIndex + 1}.html` : '';

    const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>B2 Indexer Gallery - ${album}  - Page ${pageIndex}</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet" integrity="sha384-QWTKZyjpPEjISv5WaRU9OFeRpok6YctnYmDr5pNlyT2bRjXh0JMhjY6hW+ALEwIH" crossorigin="anonymous">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css">
</head>
<body>
    <div class="container mt-2">
        <div class="row">
            <div class="col-md-6">
                <h5>${album}</h5>
            </div>
            <div class="col-md-6">
                <nav class=" float-end" aria-label="Page navigation example">
                    <ul class="pagination">
                        ${prevPage ? `<li class="page-item"><a class="page-link" href="${prevPage}">&laquo; Previous</a><li>` : ''}
                         <li class="page-item"><a class="page-link" href="index.html">Home</a><li>
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
        fs.writeFileSync(path.join(OUTPUT_FOLDER, `albums-page-${pageIndex}.html`), htmlContent);
        //fs.writeFileSync(path.join(OUTPUT_FOLDER, `albums-index.html`), htmlContent); // extra index file
    }
    else
        fs.writeFileSync(path.join(OUTPUT_FOLDER, `albums-page-${pageIndex}.html`), htmlContent);

    return { "link": `albums-page-${pageIndex}.html`, "label": album };
}

function generateHomepage(albums) {

    const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>B2 Indexer Gallery - Albums</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet" integrity="sha384-QWTKZyjpPEjISv5WaRU9OFeRpok6YctnYmDr5pNlyT2bRjXh0JMhjY6hW+ALEwIH" crossorigin="anonymous">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css">
</head>
<body>
    <div class="container mt-2">
        <div class="row">
            <div class="col-md-6">
                <h5>Albums</h5>
            </div>
            <div class="col-md-6">
            </div>
        </div>
    </div><!-- container -->

    <div class="container">
        <div class="row" id="grid">
            ${albums.map(album => `<div class="col-sm-6 col-lg-2 mt-2">
                    <div class="card">
                         <div class="card-body">
                                <p>${start_and_end(album.label)}</p>
                                <a href="${album.link}" class="btn btn-secondary btn-sm">View</a>
                         </div><!-- card -->
                    </div><!-- card -->
                </div><!-- col -->`).join('\n')}
          </div><!-- row -->
    </div><!-- container -->
    <script src="https://code.jquery.com/jquery-3.5.1.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js" integrity="sha384-YvpcrYf0tY3lHB60NNkmXc5s9fDVZLESaAA55NDzOxhy9GkcIdslK1eN7N6jIeHz" crossorigin="anonymous"></script>
</body>
</html>`;
    fs.writeFileSync(path.join(OUTPUT_FOLDER, `index.html`), htmlContent);
}

function start_and_end(str) {
    if (str.length > 35) {
        return str.substr(0, 20) + '...' + str.substr(str.length - 10, str.length);
    }
    return str;
}