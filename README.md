# B2 Indexer

Reads a backblaze b2 bucket contents and then generate a json dump and thumbnails for the contents.


## Features

* List all files inside a B2 bucket and generate a JSONL file.
* Create a scaled-down version of all the images
* Grab the first frame of videos, and store that as an image thumbnail


### Installation

```
npm install
brew install ffmpeg
```

### Generate an index

```
npm run index
```

this generates files in the dist folder.