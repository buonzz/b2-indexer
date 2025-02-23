const B2 = require('backblaze-b2');
const fs = require('fs');
const readline = require('readline');
const path = require('path');

require('dotenv').config()

const b2 = new B2({
    applicationKeyId: process.env.APPLICATION_KEY_ID,
    applicationKey: process.env.APPLICATION_KEY
});


const indexPath = path.join(__dirname, 'dist/' + 'index.jsonl');
const albumsPath = path.join(__dirname, 'dist/' + 'albums.json');
const isImage = process.env.IMAGE_EXTENSIONS.split(',').map(ext => `.${ext}`);
const isVideo = process.env.VIDEO_EXTENSIONS.split(',').map(ext => `.${ext}`);

var albums = {};


async function run() {

    const fileStream = fs.createReadStream(indexPath);

    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });


    rl.on('line', (line) => {
        const jsonLine = JSON.parse(line);
        var key = getFirstFolder(jsonLine.filename);
        var extension = path.extname(jsonLine.filename).toLowerCase();

        if (!isImage.includes(extension) && !isVideo.includes(extension)) {
            console.log('Skipped ' + jsonLine.filename);
            return;
        }


        if (key == null) {
            key = 'No Album';
        }

        if (albums.hasOwnProperty(key)) {
            albums[key].push(jsonLine.filename);
        } else {
            albums[key] = [jsonLine.filename];
        }
    });

    rl.on('close', async () => {
        fs.writeFileSync(albumsPath, JSON.stringify(albums));
        console.log('albums generated!');
    });
}

const getFirstFolder = (path) => {
    if (!path || typeof path !== 'string') {
        return null; // Return null if the input is invalid
    }

    const parts = path.split('/');
    return parts.length > 0 ? parts[0] : null;
};


run();