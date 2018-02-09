'use strict';
const debug = require('debug')('tail');

/*
	(jsdoc here is probably not compliant for parsing)

	Events:

	Recieved a new line
	@event Tail#line
	@param {string} line

	Got an error
	@event Tail#error
	@param {Object} error

	Ready for recieving new lines from file
	@event Tail#ready
	@param {number} fd - The file descriptor

	All lines recieved
	@event Tail#eof
	@param {number} position

	Would start tailing a new file from start, but file to large
	@event Tail#skip
	@param {number} position

	Starts tailing a secondary file
	@event Tail#secondary
	@param {string} filename 
	
	Restarts tail of file
	@event Tail#restart
	@param {string} reason - PRIMEFOUND, NEWPRIME, TRUNCATE

	PRIMEFOUND: Content found in a new file while NOT tailing

	NEWPRIME: Content found in a new file while tailing

	TRUNCATE: Current file decresed in size

*/

const fs = require('fs');
const { StringDecoder } = require('string_decoder');
const path = require('path');
const EventEmitter = require('events');
const bufsize = 4096;

class Tail extends EventEmitter {
	/*
		@param {string} filename
		@param {Object} [options] Set any properties
		@param {lineCallback} [cb]

		The same as listening on line events and calling Tail#start
		@callback lineCallback
		@param {string} line

		Object properties
		@prop {string} filename - primary file to tail
		@prop {string} secondary=${filename}.1 - secondary file to tail
		@prop {string} started - The filename currently tailed
		@prop {string|number} pos - 'init' or current file pos
		@prop {number} fd - Current file descriptor
		@prop {number} ino - Current file inode
		@prop {string|number} startPos - 'end', 'start' or pos for next start
		@prop {number} posLast - pos of current line during findStart()
		@prop {number} posNext - pos of next line during findStart()
		@prop {number} cutoff=5000 - max file size for starting at the top
		@prop {boolean} force - start even if no files found
		@prop {string|RegExp} sep=\n - Line separator
		@prop {string} encoding=utf8 - Any encoding recognized by StringDecoder

	 */
	
	constructor( filename, options, cb ){
		debug(`Setting up a tail of ${filename}`);
		super();
		
		const STATE = {
			filename: null,
			secondary: null,
			started: null,
			pos: 'init',
			reading: false,
			fd: null,
			buf: null,
			txt: "",
			ino: null,
			watcher: null,
			dirwatcher: null,
			startPos: 'end',
			cutoff: 5000,
			force: false,
			sep: "\n",
			decoder: null,
			encoding: 'utf8',
		};
		Object.assign( this, STATE );

		this.filename = filename;

		if( typeof options == 'function' ){
			cb = options;
			options = undefined;
		}

		if( !options ) options = {};
		Object.assign( this, options );

		this.decoder = new StringDecoder(this.encoding);

		if( !this.secondary ) this.secondary = filename + ".1";

		if( cb ){
			this.on('line', cb);
			this.start();
		}
		
		return this;
	}


	start(){
		return this.tryTail( this.filename ).catch( err =>{
			if( err.code !== 'ENOENT' ) throw err;
			this.err1 = err;
			
			debug(`${this.filename} gone. Trying ${this.secondary}`);
			return this.tryTail( this.secondary );
		}).catch( err =>{
			if( this.err1 ){ // report error for the primary file
				this.onError( this.err1 );
				delete this.err1;
			} else {
				this.onError( err );
			}

			if( this.force ){
				this.started = this.filename;
				this.watchForPrimary();
			}
		});
	}

	findStart( match, cmp ){
		/*
			@param {RegExp} match - regexp for finding starting line
			@param {function} cmp - compare function for finding starting line
		 */

		debug("Find start with", match);
		return this
			.findStartInFile( this.filename, match, cmp )
			.catch( err =>{
				if( err.code !== 'NOTFOUND' ) throw err;
				this.err1 = err;
			
				debug(`Start not found in ${this.filename}. Trying ${this.secondary}`);
				return this.findStartInFile( this.secondary, match, cmp );

			})
			.then( pos => {
				this.setPos( pos );
				debug(`Found start in ${this.started} at pos ${this.pos}`);

				return this.tryTail( this.started );
			})
			.catch( err =>{
				if( err.code !== 'NOTFOUND' ){
					if( this.err1 ){ // report error for the primary file
						this.onError( this.err1 );
						delete this.err1;
					} else {
						this.onError( err );
					}
				} else {
					err.message = "Start not found in primary or secondary file";
					this.onError( err );
				}
				
				if( this.force ){
					return this.start();
				}

				return err;
			});
	}

	findStartInFile( filename, match, cmp ){
		/*
			@param {string} filename - file to search for start
			@param {RegExp} match - regexp for finding starting line
			@param {function} cmp - compare function for finding starting line
		 */

		debug("Find start in", filename);

		return new Promise( (resolve,reject)=>{
			this.stop();
			fs.stat( filename, ( err,stats )=>{
				if( err ){
					if( err.code !== 'ENOENT' ) return reject( err );
					err.code = 'NOTFOUND'; // Tell caller to continue search
					return reject( err );
				}

				this.started = filename;
				this.sepG = new RegExp( this.sep, 'g' );
				this.ino = stats.ino;
				this.setPos( 0 );

				debug('Looking for first line');
				let posFound = -1;
				
				this.onLine = (err, line ) =>{
					if( err ){
						if( err.code != 'EOF' ) return reject( err );
						
						if( posFound >= 0 ){
							err.message = `The target value comes after ` +
								`the end of this file`;
							return reject( err );
						}

						err.code = 'NOTFOUND'; // Might be in previous log
						return reject( err );
					}

					const found = line.match( match );
					if( !found ) return setImmediate( this.getNext.bind(this) );
					const compared = cmp( found[1] );

					//## Detaild debug for every line found
					//debug( this.posLast, found[1], compared, line );

					if( compared == 0 ){
						return resolve( this.posLast );
					}

					if( compared < 0 ){ // target line is before this
						if( posFound >= 0 ) return resolve( this.posLast );
						
						const err = new Error(`The found value ${found[1]} `+
																	`comes before start of this file`)
						err.code = 'NOTFOUND';
						return reject( err );

					}

					if( compared > 0 ){ // target line is after this

						// TODO: Jump around in file as to not have to read every
						// single line. Will save time for large files!

						posFound = this.posLast;
						return setImmediate( this.getNext.bind(this) );
					}

					throw new Error("Given comparison function returned " + compared);
				};

				this.readNext();

			});
		});
	}
	
	async tryTail( filename ){
		if( this.started && this.started !== filename ) this.stop();

		this.started = filename;
		this.watcher = fs.watch(filename );
		fs.stat(filename, this.getStat.bind(this) );
		this.readStuff(); // Do not wait in case we don't start at the end

		this.watcher.on('change', this.readStuff.bind(this) ); // even if rename
		this.watcher.on('error', this.onError.bind(this) );

		if( filename == this.secondary ){
			this.emit('secondary', this.secondary);
			this.watchForPrimary();
		}
	}

	watchForPrimary(){
		if( this.dirwatcher ) return;

		debug(`Start watching for the return of ${this.filename}`);

		const dirname = path.dirname( this.filename );

		this.dirwatcher = fs.watch( dirname );
		this.dirwatcher.on('change', this.checkDir.bind(this) );
		this.dirwatcher.on('error', this.onError.bind(this) );
	}

	checkDir(type, name ){
		//debug(`Dir ${type}: ${name}`);
		if( name !== this.filename ) return;
		debug(`Dir ${type}: ${name}`);

		// It will decide if it's time to switch over
		if( this.fd ) return this.readStuff();

		this.stop();
		this.setPos(0);
		this.emit('restart','PRIMEFOUND');
		return setImmediate( this.start.bind(this) );
	}

	onError( err ){
		// handle all file and watcher errors
		this.stop();
		debug( err );
		this.emit( 'error', err );
	}

	stop(){
		if( this.started ){
			debug(`Stops tail of ${this.started}`);
		}
		
		if( this.dirwatcher ){
			this.dirwatcher.close();
			delete this.dirwatcher;
		}
		
		if( this.watcher ){
			this.watcher.close();
			delete this.watcher;
		}

		if( this.fd ){
			if( this.fd !==  'init' ){
				debug("Closing fd " + this.fd);
				fs.close( this.fd, err =>{
					if( err ) return debug( "closing1 " + err );
				});
			}
			delete this.fd;
		}

		this.started = null;
	}

	getStat( err, stats ){
		if( err ) return this.onError( err );

		let start = stats.size;
		if( typeof this.startPos == 'number' ){
			if( this.startPos <= stats.size ) start = this.startPos;
		} else if( this.startPos == 'start' ){
			if( stats.size <this.cutoff ){
				start = 0;
			} else {
				this.emit('skip',start);
			}
		}

		this.pos = start;
		this.ino = stats.ino;
		debug(`Starting tail at ${this.pos}`);
	}

	createReader(){
		if( this.fd ) return;
		this.fd = 'init';
		fs.open(this.started,'r', (err,fd) =>{
			if(err) return this.onError( err );
			if(!this.fd){ // in the middle of stop()
				debug("Closing2 fd " + this.fd);
				fs.close( fd, err =>{
					if( err ) return debug( "closing " + err );
				});
				return;
			}
			debug("Opened file as fd " + fd);
			this.emit('ready', fd);
			this.fd = fd;
			this.readStuff();
		});
	}

	readStuff(){
		if( !this.started ) return;
		this.createReader();
		if( this.fd == 'init' ) return;
		if( this.pos == 'init' ) return;
		if( this.reading ) return;
		this.reading = true;

		//debug("Starts reading at " + this.pos);
		if(!this.buf) this.buf = Buffer.alloc(bufsize);
		fs.read( this.fd, this.buf, 0, bufsize, this.pos, this.parseStuff.bind(this) );
	}

	parseStuff(err, bytesRead, buf ){
		this.reading = false;
		if( err ) return this.onError( err );

		let data;
		if( bytesRead == 0 ){
			data = this.decoder.end(); // might have partial characters
		} else {
			this.pos += bytesRead;
			//debug(`Read ${bytesRead} bytes`);
			data = this.decoder.write( buf.slice(0,bytesRead) );
		}

		// Everything else comes down to this line
		const newLines = (this.txt+data).split(this.sep);

		// this.txt will be the content after the last linebreak. For the
		// end of file, it will be an empty string if the file ended with
		// a linebreak.
		this.txt = newLines.pop();

		for( let line of newLines ){
			//debug( "Line »" + line + '«' );
			this.emit('line', line );
		}

		if( bytesRead == 0 ) return this.onEndOfFile();

		setImmediate( this.readStuff.bind(this) );
	}

	onEndOfFile(){
		debug("End of file\n");
		//debug("Should we switch the streams?");
		fs.stat(this.filename, (err,stat) =>{
			if( err ){
				if( debug.enabled ){
					if( err.code == 'ENOENT' ){
						if( !this.dirwatcher ) debug(`${this.filename} does not exist`);
					}
					else debug(err);
				}
				
				this.watchForPrimary(); // usually the right response
				return;
			}
			
			if( this.ino != stat.ino ){
				if( stat.size ){
					debug("Switching over to the new file");
					this.stop();
					this.setPos(0);
					this.emit('restart','NEWPRIME');
					return setImmediate( this.start.bind(this) );
				}

				// Wait until it has something to read
				return this.watchForPrimary();

			} else if( stat.size < this.pos ){
				debug("File truncated");
				this.stop();
				this.setPos(0);
				this.emit('restart','TRUNCATE');
				return setImmediate( this.start.bind(this) );
			}

			this.emit('eof', this.pos);
		});

	}

	setPos( pos ){
		this.startPos = pos;
		if( pos == 'start' ) pos = 0;
		this.posLast = pos;
		this.posNext = pos;
		this.pos = pos;
		this.txt = '';
	}
	
	createReaderForNext(){
		if( this.fd ) return;
		this.fd = 'init';
		fs.open(this.started,'r', (err,fd) =>{
			if(err) return this.onLine( err );
			if(!this.fd){ // in the middle of stop()
				debug("Closing2 fd " + this.fd);
				fs.close( fd, err =>{
					if( err ) return debug( "closing " + err );
				});
				return;
			}
			debug("Opened file as fd " + fd);
			this.fd = fd;
			this.readNext();
		});
	}

	readNext(){
		if( !this.started ) return;
		this.createReaderForNext();
		if( this.fd == 'init' ) return;
		if( this.pos == 'init' ) return;
		if( this.reading ) return;
		this.reading = true;

		if(!this.buf) this.buf = Buffer.alloc(bufsize);
		fs.read( this.fd, this.buf, 0, bufsize, this.pos,
						 this.appendForNext.bind(this) );
	}

	appendForNext(err, bytesRead, buf ){
		this.reading = false;
		if( err ) return this.onLine( err );

		if( bytesRead == 0 ){
			this.txt += this.decoder.end(); // might have partial characters
			return this.onEndOfFileForNext();
		}

		this.pos += bytesRead;
		this.txt += this.decoder.write( buf.slice(0,bytesRead) );

		this.getNext();
	}

	getNext(){
		const found = this.sepG.exec( this.txt );
		//debug("Textbuffer: " + this.txt);
		if( !found ) return this.readNext();
		//debug( found );
		
		const line = this.txt.substr( 0, found.index );
		
		this.posLast = this.posNext;
		this.posNext += this.sepG.lastIndex;

		
		this.txt = this.txt.substr( this.sepG.lastIndex );
		this.sepG.lastIndex = 0;
		//debug( "Rest " + this.txt );
		//debug( "Line »" + line + '«' );
		
		return this.onLine( null, line );
	}

	onEndOfFileForNext(){
		debug("End of file for next\n");
		const err =  new Error("EOF");
		err.code = 'EOF';
		return this.onLine( err );
	}

}

module.exports = Tail;


// EOF
