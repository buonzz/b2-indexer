const B2 = require('backblaze-b2');
const fs = require('fs');
const readline = require('readline');
const path = require('path');
const sharp = require('sharp');
const { exec } = require('child_process');

require('dotenv').config()

const b2 = new B2({
    applicationKeyId: process.env.APPLICATION_KEY_ID,
    applicationKey: process.env.APPLICATION_KEY
});

const folderPath = path.join(__dirname, 'dist/thumbs/');
const indexPath = path.join(__dirname, 'dist/' + process.env.BUCKET_ID + '-index.jsonl');
const linksPath = path.join(__dirname, 'dist/' + process.env.BUCKET_ID + '-download-links.json');
var newLinks = {};


async function run() {

    const fileStream = fs.createReadStream(indexPath);
    var authorizationToken = null;
    var apiUrl = null;
    var bucketName = null;

    try {
        var authorize_resp = await b2.authorize();
        authorizationToken = authorize_resp.data.authorizationToken;
        apiUrl = authorize_resp.data.apiUrl;
        bucketName = authorize_resp.data.allowed.bucketName;
    } catch (err) {
        console.log('Error authorizing bucket');
        return;
    }

    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });


    rl.on('line', (line) => {
        const jsonLine = JSON.parse(line);
        var key = jsonLine.filename.replace(/\//g, '_');
        newLinks[key] = getFileUrl(jsonLine.filename, authorizationToken, apiUrl, bucketName);
    });

    rl.on('close', async () => {
        fs.writeFileSync(linksPath, JSON.stringify(newLinks));
        console.log('Links generated!');
    });
}

async function onLineRead(line, authorizationToken, apiUrl, bucketName) {
    const jsonLine = JSON.parse(line);
    var extension = path.extname(jsonLine.filename).toLowerCase();

    try {
        console.log('Processing file ' + jsonLine.filename);
        await generateVideoThumbnail(jsonLine, authorizationToken, apiUrl, bucketName);
    } catch (err) {
        console.log(err);
    }
}

async function processImage(jsonLine) {

    const filePath = folderPath + jsonLine.filename.replace(/\//g, '_');
    const percentage = 5;


    if (fs.existsSync(filePath)) {
        console.log(filePath + ' already exists, skipped');
        return;
    }

    let b2_response = await b2.downloadFileById({
        fileId: jsonLine.fileId,
        responseType: 'arraybuffer'
    });

    try {
        const metadata = await sharp(b2_response.data).metadata();
        const width = Math.round(metadata.width * percentage / 100);
        const height = Math.round(metadata.height * percentage / 100);
        const output = await sharp(b2_response.data).resize(width, height).toBuffer();
        fs.writeFileSync(filePath, output);
    } catch (error) {
        console.error(`Error processing image ${jsonLine.filename}:`, error);
    }
}



function getFileUrl(filename, authorizationToken, apiUrl, bucketName) {
    return `${apiUrl}/file/${bucketName}/${filename}?Authorization=${authorizationToken}`;
}

run();