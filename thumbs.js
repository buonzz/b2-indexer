const B2 = require('backblaze-b2');
const fs = require('fs');
const readline = require('readline');
const path = require('path');
const sharp = require('sharp');
const { exec } = require('child_process');

require('dotenv').config()

const b2 = new B2({
    applicationKeyId: process.env.APPLICATION_KEY_ID, // or accountId: 'accountId'
    applicationKey: process.env.APPLICATION_KEY // or masterApplicationKey
});

const folderPath = path.join(__dirname, 'dist/thumbs/');
const tmpFolderPath = path.join(__dirname, 'tmp/');
const indexPath = path.join(__dirname, 'dist/' + process.env.BUCKET_ID + '-index.jsonl');

const isImage = ['.jpg', '.jpeg', '.png']; //you can add more
const isVideo = ['.mov', '.mp4']; // you can add more extension


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
        //console.log(authorize_resp);
    } catch (err) {
        console.log('Error authorizing bucket');
    }

    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });

    rl.on('line', (line) => { onLineRead(line, authorizationToken, apiUrl, bucketName) });

    rl.on('close', () => {
        //console.log('Finished reading index.');
        //console.log('Success!');
    });
}

async function onLineRead(line, authorizationToken,
    apiUrl, bucketName) {
    const jsonLine = JSON.parse(line);
    var extension = path.extname(jsonLine.filename);
    extension = extension.toLowerCase();

    if (!isImage.includes(extension) && !isVideo.includes(extension)) {
        console.log('skipped ' + jsonLine.filename);
        return;
    }

    try {
        const filePath = folderPath + jsonLine.filename;
        console.log('processing file ' + jsonLine.filename);

        // grab the image and scale down
        if (isImage.includes(extension)) {
            let b2_response = await b2.downloadFileById({
                fileId: jsonLine.fileId,
                responseType: 'arraybuffer',
                onDownloadProgress: (event) => { console.log(event) }
            });

            const percentage = 5;
            sharp(b2_response.data).metadata()
                .then(info => {
                    const width = Math.round(info.width * percentage / 100);
                    const height = Math.round(info.height * percentage / 100);
                    return sharp(b2_response.data).resize(width, height).toBuffer();
                })
                .then(output => {
                    fs.writeFileSync(filePath, output);
                });
        }

        if (isVideo.includes(extension)) {
            generateVideoThumbnail(jsonLine, authorizationToken,
                apiUrl, bucketName);
        }

    } catch (err) {
        console.log(err);
    }
}

async function generateVideoThumbnail(jsonLine, authorizationToken,
    apiUrl, bucketName) {

    const videoUrl = getFileUrl(jsonLine.filename, authorizationToken,
        apiUrl, bucketName);

    //console.log(videoUrl);
    const outputThumbnail = folderPath + jsonLine.filename + '-thumb.jpg';

    const ffmpegCmd = `ffmpeg -i "${videoUrl}" -ss 00:00:05 -vframes 1 -q:v 2 -update 1 "${outputThumbnail}"`;

    exec(ffmpegCmd, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error generating thumbnail: ${error.message}`);
            return;
        }
        if (stderr) console.log(`FFmpeg output: ${stderr}`);
        console.log(`Thumbnail saved as ${outputThumbnail}`);
    });
}

function getFileUrl(filename, authorizationToken,
    apiUrl, bucketName) {
    return `${apiUrl}/file/${bucketName}/${filename}?Authorization=${authorizationToken}`;
}


run();