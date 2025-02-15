# B2 Indexer

Reads a Backblaze b2 bucket contents and then generate a json dump and thumbnails for the contents.


## Features

* List all files inside a B2 bucket and generate a JSONL file.
* Create a scaled-down version of all the images
* Grab the first frame of videos, and store that as an image thumbnail


### Installation

```
npm install
brew install ffmpeg
```

## Configure the B2 Details

```
cp .env.example .env
```
open the `.env` file and fill up the following details

```
APPLICATION_KEY_ID=
APPLICATION_KEY=
BUCKET_ID=
```


### Generate an index

```
npm run index
```

this generates the JSON file in the dist folder.


### Generate the thumbnails

```
npm run thumbs
```

this reads the JSONL file from previous step, then generate thumbnail for each.



### Generate static website

```
npm run website
```

to open the site
```
http-server -o dist/
```


### Workflow

Normally, you would run the indexer more often, then generate thumbnail once in a while.