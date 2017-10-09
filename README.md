# tail-file
Node module for tailing files. Fast, easy, persistent, fault tolerant and flexible.

```js
const Tail = require('tail-file');
const mytail = new Tail("myfile.log", line => {
  console.log( line );
});
```

## Features

It will deliver new lines from a file.
 * Without delay. It's using `fs.watch`. No poll interval.
 * Even if you move the file, as with a log rotation.
 * Even if you restart the program in the middle of the log rotation, by tailing the secondary file.
 * When the file has been moved and new lines starts appearing in the original location, it will switch over to the new file.
 * But it will always finish up reading the rest of the lines from the current file. Not getting distracted by empty files.
 * When switching to a new file, it will start from the beginning, as to not miss any rows.
 * except if the new file actually was copied or moved into place, with too many existing rows, in which case it will continue from the bottom.
 * It will never throw exceptions. No matter what type of errors. All errors are emitted as messages.
 * All the code is asynchronous. No waiting on file system. Tried to avoid all race conditions.
 * And most of this is very configurable and hackable.

## Events

With no callback provided, the tailing will not start until you tell it to. Here is longer example. Use the parts you need.

```js
const Tail = require('tail-file');

const mytail = new Tail("myfile.log");

mytail.on('error', err => throw(err) );

mytail.on('line', line => console.log(line) );

mytail.on('ready', fd => console.log("All line are belong to us") );

mytail.on('skip', pos => console.log("myfile.log suddenly got replaced with a large file") );

mytail.on('secondary', filename => console.log(`myfile.log is missing. Tailing ${filename} instead`) );

mytail.on('restart', reason => {
  if( reason == 'PRIMEFOUND' ) console.log("Now we can finally start tailing. File has appeared");
  if( reason == 'NEWPRIME' ) console.log("We will switch over to the new file now");
  if( reason == 'TRUNCATE' ) console.log("The file got smaller. I will go up and continue");
});

mytail.start();
```

All internals are exposed in the object. Use with care. :)

You can also set or replace any of the properties or methods by passing them in as a options parameter.

## Options

```js
const mytail = new Tail( "filename", { ... options ... }, callback );
```

*secondary* = ${filename}.1
The file to tail if the primary `filename` is not found. 

*startPos* = 'end'
Where to start tailing. It can be `start` or `end` or an actual byte position in the file.

*cutoff* = 5000
New files appearing after tailing started, will be tailed from the start, unless they are larger than this many bytes, in which case they will be tailed from the tail.

*force* = false
If force is true, it will start waiting for a file to tail even if it can't find the file and also can't find the secondary file. The default is to send an error message with `ENOENT` telling that it can't find the file.

*sep* = \n
The line separator. May be a regexp. For example `/\r?\n/`.

*encoding* = utf8
Any encoding recognized by nodes StringDecoder. This includes ucs2, utf16le, latin1, base64 and more.

There are other properties that can be read or modified. Take a look in the source.

## Finally

This module was partly inspired by [always-tail](https://github.com/jandre/always-tail)

No care has been given to make this module work on older versions of node. Developed and tested on GNU/Linux. But it should work on other platforms.
