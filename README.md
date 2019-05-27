# tail-file
Node module for tailing files. Fast, easy, persistent, fault tolerant and flexible.

```js
const Tail = require('tail-file');
const mytail = new Tail("myfile.log", line => {
  console.log( line );
});
```

## Promises

```js
try {
		await mytail.startP();
		const line = await mytail.nextLine();
}
catch( err ){
		throw( err );
}
```

## Events

With no callback provided, the tailing will not start until you tell it to. Here is longer example. Use the parts you need.

```js
const Tail = require('tail-file');

const mytail = new Tail("myfile.log"); // absolute or relative path

mytail.on('error', err => throw(err) );

mytail.on('line', line => console.log(line) );

mytail.on('ready', fd => console.log("All line are belong to us") );

mytail.on('eof', pos => console.log("Catched up to the last line") );

mytail.on('skip', pos => console.log("myfile.log suddenly got replaced with a large file") );

mytail.on('secondary', filename => console.log(`myfile.log is missing. Tailing ${filename} instead`) );

mytail.on('restart', reason => {
  if( reason == 'PRIMEFOUND' ) console.log("Now we can finally start tailing. File has appeared");
  if( reason == 'NEWPRIME' ) console.log("We will switch over to the new file now");
  if( reason == 'TRUNCATE' ) console.log("The file got smaller. I will go up and continue");
  if( reason == 'CATCHUP' ) console.log("We found a start in an earlier file and are now moving to the next one in the list");
});

mytail.start();
```

## Features

It will deliver new lines from a file.
 * Without delay. It's using `fs.watch`. No poll interval.
 * Even if you move the file, as with a log rotation.
 * Even if you restart the program in the middle of the log rotation, by tailing the secondary file.
 * When the file has been moved and new lines starts appearing in the original location, it will switch over to the new file.
 * But it will always finish up reading the rest of the lines from the current file. Not getting distracted by empty files.
 * When switching to a new file, it will start from the beginning, as to not miss any rows.
 * Optionally skipping to the bottom if the file is larger than a given limit.
 * You can let tail-file search for the starting position, and it will continue at that position, even if it's in the secondary file.
 * It will never throw exceptions. No matter what type of errors. All errors are emitted as messages.
 * All the code is asynchronous. No waiting on file system. Tried to avoid all race conditions.
 * And most of this is very configurable and hackable.


## methods

`start()` : Starts the tailing. No return value.

`startP()` : Starts the tailng. Returns a promise.

`getSecondary()` : Returns a promise for the secondary filename.

`findStart()` : Starts tail from the row with the selected content. Returns a promise.

`nextLine()` : Returns a promise for the next line.

`stop()` : Stops the tailing. Returns a promise for completion.


## Continue tail at last known position

If you want to start where you left of the tail and not miss any lines, even if the last known line has been log rotated, you can use `findStart()`.

It will start the tail at the line matching the given regexp that passes the comparison test. Suitable for log files that has sorted values, like timestamps or number sequences.

If the first matching line of the file comes after the target position, it will look for the target line in older files. If the line is found in an older file, the tail will start. After all the lines of the older files has been reported, the tail will continue with the primary file as usual.

You can assign a function returning an iterable object to `secondaryFiles()`. It will default return filenames compatible with the default logrotate configuration. Files with `.gz` will be decompressed before parsing.

### Syntax
```
tailObj.findStart( match, cmp )
```

### Parameters
    {RegExp} match
A regexp for finding starting line. The first captured substring will be sent to the comparison function. Lines not matching the regexp will be ignored.

    {function} cmp
A compare function for finding starting line. For each line matching the match regexp, the cmp function will be called with the first captured substring.

`cmp` must return a positive number if the target line comes after the current line.

### Return value

Returns a promise that are resolved when the start was found and the tailing started.

If the log contains a line before the target, followed by a line after the target, we will start the tailing with the first line after the line before the target, that matches the regexp. You can set up any special logic for handling this case in the event handler for lines, after the tailing has started.

The promise will be rejected if there was an error reading the files or if the target line wasn't found in the primary or secondary file.

If the `force` option is set to true, the tail will start even if there was an error.

### Example

This will continue the tail at the line matching the date. This example uses ISO Dates which can be compared as strings.

```	
const timestamp = '2020-01-01 00:00:00';
mytail.findStart( /^(\d+-\d+-\d+ \d+:\d+:\d+)/, date => timestamp.localeCompare(date)  );
```

## Options

All internals are exposed in the object. Use with care. :)

You can also set or replace any of the properties or methods by passing them in as a options parameter.


```js
const mytail = new Tail( "filename", { ... options ... }, callback );
```

*secondary* = ${filename}.1
>The file to tail if the primary `filename` is not found. 

*startPos* = 'end'
>Where to start tailing. It can be `start` or `end` or an actual char position in the file. NB! Not to get mixed up with the byte postion of pos.

*cutoff* = 0
>New files appearing after tailing started, will be tailed from the start, unless they are larger than this many bytes, in which case they will be tailed from the tail. The default is 0 which disables this check.

*force* = false
>If force is true, it will start waiting for a file to tail even if it can't find the file and also can't find the secondary file. The default is to send an error message with `ENOENT` telling that it can't find the file.

*sep* = \n
>The line separator. May be a regexp. For example `/\r?\n/`.

*encoding* = utf8
>Any encoding recognized by nodes StringDecoder. This includes ucs2, utf16le, latin1, base64 and more.

There are other properties that can be read or modified. Take a look in the source.

## Caveat

Current implementation reports the char position of lines rather than the byte position.

## Finally

This module was partly inspired by [always-tail](https://github.com/jandre/always-tail)

No care has been given to make this module work on older versions of node. Tested on Linux and Windows. But it should work on other platforms.
