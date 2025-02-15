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
const tmpFolderPath = path.join(__dirname, 'tmp/');
const indexPath = path.join(__dirname, 'dist/' + process.env.BUCKET_ID + '-index.jsonl');

const isImage = ['.jpg', '.jpeg', '.png'];
const isVideo = ['.mov', '.mp4'];

async function run() {
    const pLimit = (await import('p-limit')).default;
    const limit = pLimit(5); // Limit concurrent FFmpeg processes
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

    const tasks = [];

    rl.on('line', (line) => {
        tasks.push(limit(() => onLineRead(line, authorizationToken, apiUrl, bucketName)));
    });

    rl.on('close', async () => {
        await Promise.all(tasks);
        console.log('All files processed!');
    });
}

async function onLineRead(line, authorizationToken, apiUrl, bucketName) {
    const jsonLine = JSON.parse(line);
    var extension = path.extname(jsonLine.filename).toLowerCase();

    if (!isImage.includes(extension) && !isVideo.includes(extension)) {
        console.log('Skipped ' + jsonLine.filename);
        return;
    }

    try {
        console.log('Processing file ' + jsonLine.filename);

        if (isImage.includes(extension)) {
            await processImage(jsonLine);
        }

        if (isVideo.includes(extension)) {
            await generateVideoThumbnail(jsonLine, authorizationToken, apiUrl, bucketName);
        }

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

async function generateVideoThumbnail(jsonLine, authorizationToken, apiUrl, bucketName) {
    return new Promise((resolve, reject) => {

        const videoUrl = getFileUrl(jsonLine.filename, authorizationToken, apiUrl, bucketName);
        const outputThumbnail = folderPath + jsonLine.filename.replace(/\//g, '_') + '-thumb.jpg';
        const ffmpegCmd = `ffmpeg -i "${videoUrl}" -ss 00:00:05 -vframes 1 -q:v 2 -update 1 "${outputThumbnail}"`;

        if (fs.existsSync(outputThumbnail)) {
            console.log(outputThumbnail + ' already exists, skipped');
            return reject(outputThumbnail + ' already exists, skipped');
        }

        exec(ffmpegCmd, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error generating thumbnail for ${jsonLine.filename}: ${error.message}`);
                return reject(error);
            }
            if (stderr) console.log(`FFmpeg output for ${jsonLine.filename}: ${stderr}`);
            console.log(`Thumbnail saved as ${outputThumbnail}`);
            resolve(outputThumbnail);
        });
    });
}

function getFileUrl(filename, authorizationToken, apiUrl, bucketName) {
    return `${apiUrl}/file/${bucketName}/${filename}?Authorization=${authorizationToken}`;
}

run();