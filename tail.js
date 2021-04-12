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
	@param {number} byte position

	Would start tailing a new file from start, but file to large
	@event Tail#skip
	@param {number} byte position

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

const util = require('util');
const fs_access = util.promisify(fs.access);
const fs_stat = util.promisify( fs.stat );

//let _idseq = 0;

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
		@prop {string|number} pos - 'init' or current file byte position
		@prop {number} fd - Current file descriptor
		@prop {number} ino - Current file inode
		@prop {string|number} startPos - 'end', 'start' or char pos for next start
		@prop {number} posLast - char pos of current line during findStart()
		@prop {number} posNext - char pos of next line during findStart()
		@prop {number} cutoff=0 - max file size for starting at the top
		@prop {boolean} force - start even if no files found
		@prop {string|RegExp} sep=\n - Line separator
		@prop {string} encoding=utf8 - Any encoding recognized by StringDecoder
		@prop {number} _bufsize - Size of buffer defaults to 4096

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
			readable: false, // only used by checkDir
			fd: null,
			buf: null,
			txt: "",
			ino: null,
			watcher: null,
			startPos: 'end',
			cutoff: 0,
			force: false,
			sep: "\n",
			decoder: null,
			encoding: 'utf8',
			backlog: [],
			unzip: null,
			_bufsize: 4096,
		};
		Object.assign( this, STATE );

		this.filename = filename;

		if( typeof options === 'function' ){
			cb = options;
			options = undefined;
		}

		if( !options ) options = {};
		Object.assign( this, options );

		this.secondaryFiles = this.secondaryFilesDefault,
		this.decoder = new StringDecoder(this.encoding);

		if( cb ){
			this.on('line', cb);
			this.start();
		}
		
		return this;
	}

	start( filename ){
		const self = this;

		if( !filename ) filename = self.filename;
		
		//debug('start', filename);

		function onError( err ){
			offEvents();

			//debug('start err', err);

			if( self.stopping ) return self.interrupt();
			
			if( filename === self.filename ){

				//debug('start prime err', err);
				if( err.code !== 'ENOENT' ){
					return self.onError( err );
				}

				self.err1 = err;
				self.getSecondary().then( secondary =>{
					if( self.stopping ) return self.interrupt();

					debug(`${self.filename} gone. Trying ${secondary}`);
					self.starting = null;
					self.start( secondary );
				});

			} else {

				//debug('start sec err', err);
				self.starting = null;
				if( self.err1 ){ // report error for the primary file
					self.onError( self.err1 );
					delete self.err1;
				} else {
					self.onError( err );
				}
				
				if( self.force ){
					self.started = self.filename;
				}

			}
			
		}

		function onReady(){
			offEvents();
			//debug('starting', self.starting, 'done');
			self.starting = null;
		}

		function offEvents(){
			self.off('tailError', onError );
			self.off('error', onError );
			self.off('ready', onReady);
		}

		if( this.started === filename ){
			this.emit('ready', this.fd);
			return;
		}
		
		self.stop().then(()=>{
			debug('starting', filename);
			self.starting = filename;
			self.on('tailError', onError );
			self.on('error', onError );
			self.on('ready', onReady );
			self.tryTail( filename );
		});
		
	}

	startP( filename ){
		const self = this;
		//if( self.fd ) return Promise.resolve();

		if( self.started && self.started === filename ){
			self.tryTail( filename );
			return Promise.resolve(true);
		}
		
		const p = new Promise( (resolve,reject) =>{

			function onError( err ){
				self.off('ready', onReady );
				self.off('error', onError );
				//debug('startP reject');
				reject( err );
			}

			function onReady(){
				self.off('ready', onReady );
				self.off('error', onError );
				//debug('startP resolve');
				resolve(true);
			}
			
			self.on('error', onError );
			self.on('ready', onReady );
		});

		//debug('startP');
		self.start( filename );
		return p;
	}

	async getSecondary(){
		//return this.filename + ".1";
		if( this.secondary ) return this.secondary;
		//debug('getSecondary');

		const first = await this.secondaryFiles[Symbol.asyncIterator]().next();
		return first.value;
	}
	
	get searchFiles(){
		const tail = this;
		return {
			async *[Symbol.asyncIterator]() {
				//debug('in searchFiles');
				yield tail.filename;
				yield* tail.secondaryFiles;
			}
		}
	}

	get secondaryFilesDefault(){
		const tail = this;
		return {
			async *[Symbol.asyncIterator]() {
				let count = 1;
				//const _id = ++ _idseq;
				let zip = false;
				const base = tail.filename;

				//debug('searching init', _id );
				
				counting: while( true ){
					let filename = `${base}.${count}`;
					if( zip ) filename += ".gz";

					//debug('searching for file', filename);

					try {
						const res = await fs_access(filename);

						//debug('yielding', _id, filename);
						yield filename;
						count ++;
						continue counting;
					} catch( err ){
						//debug('not found', err);

						if( zip ){

							// Return .1 even if not existing
							if( count === 1 ){
								//debug('yielding', _id, `${base}.1`);
								yield `${base}.1`;
							}

							//debug('searching breaking', _id);
							break counting;
						}
					}

					//debug('searching for zipped', _id);
					zip = true;
				}

				//debug('searching ended', _id);
			}
		}
	}

	async findStart( match, cmp ){
		/*
			@param {RegExp} match - regexp for finding starting line
			@param {function} cmp - compare function for finding starting line
		 */

		debug("Find start with", match, this.pos);

		delete this.err1;
		this.backlog = [];
		let foundLine;

		for await ( let filename of this.searchFiles ){
			try {
				foundLine = await this.findStartInFile( filename, match, cmp );
				this.startPos = this.posSkip = this.posLast;
				break;
			} catch( err ){
				// debug('fsif', err.code, err.message);
				if( !['NOTFOUND','ENOENT','TARGETOLDER'].includes( err.code ) ){
					throw err;
				} else if( err.code === 'NOTFOUND' && this.backlog.length ){
					debug("Starting row inbetween files");
					break;
				} else {
					debug('backlog', filename, err.code);
					this.backlog.push( filename );
					if( !this.err1 ) this.err1 = err;
					this.started = null;
					this.reading = false;
				}
			}
		}

		if( this.started ){
			debug(`Found start in ${this.started} at char pos ${this.startPos}: ${foundLine}`);
			try {
				//debug('foundLine', foundLine);
				if( typeof foundLine === 'string' ) this.emit('line', foundLine );
				if( this.stopping || !this.started ) return;
				return await this.startP( this.started );
			} catch( err ){
				debug('in fstt', err);
				this.err1 = err;
			}
		}

		const err = this.err1;
		if( err.code === 'TARGETOLDER' ) err.code = 'NOTFOUND';
		
		if( err.code === 'NOTFOUND' ){
			err.message = "Start not found in primary or any secondary file";
			err.files = this.backlog;
		}
		
		this.onError( err );
		
		if( this.force ){
			return this.start();
		}
		
		throw err;
	}

	async findStartInFile( filename, match, cmp ){
		/*
			@param {string} filename - file to search for start
			@param {RegExp} match - regexp for finding starting line
			@param {function} cmp - compare function for finding starting line
		 */

		debug("Find start in", filename);

		this._stop();

		const stats = await fs_stat( filename );
		
		this.started = filename;
		this.sepG = new RegExp( this.sep, 'g' );
		this.ino = stats.ino;
		this.setBytePos( 0 );
		
		//debug('Looking for first line');
		let posFound = -1;
		let valFound;

		////#### returns found line
		return await new Promise( (resolve,reject) =>{
		
			this.onEndOfFile = this.onEndOfFileForFind;
			this.onLine = (err, line, pos ) =>{
				if( err ){
					if( err.code !== 'EOF' ){
						debug("onLine", filename, "error", err.code);
						return reject( err );
					}
					
					if( posFound >= 0 ){
						err.message =
						`The last matched line has the value ${valFound}. `+
						`The target value comes after the end of this file.`
						err.code = 'NOTFOUND';
					} else {
						err.code = 'TARGETOLDER'; // Might be in previous log
					}

					return reject( err );
				}
				
				// debug( `Line ${pos} »${line}«`);
				
				const found = line.match( match );
				if( !found ) return setImmediate( this.getLine.bind(this) );
				const compared = cmp( found[1] );
				
				//## Detaild debug for every line found
				// debug( this.posLast, found[1], compared, line );
				
				if( compared === 0 ){
					return resolve( line );
				}
				
				if( compared < 0 ){ // target line is before this
					if( posFound >= 0 ) return resolve( line );
					
					const msg =
								`The first matched line has the value ${found[1]}. `+
								`The target value are probably in an older file.`;
					
					const err = new Error( msg )
					err.code = 'TARGETOLDER';
					return reject( err );
					
				}
				
				if( compared > 0 ){ // target line is after this
					
					// TODO: Jump around in file as to not have to read every
					// single line. Will save time for large files!
					
					posFound = this.posLast;
					valFound = found[1];
					return setImmediate( this.getLine.bind(this) );
				}
				
				return reject( new Error("Given comparison function returned " + compared ) );
			};
			
			this.readStuff();
		});
	}
	

	nextLine(){
		return new Promise( resolve => this.once('line', resolve ) );
	}

	tryTail( filename ){
		if( this.started && this.started !== filename ) this._stop();
		// Might be started by findStart()
		
		this.sepG = new RegExp( this.sep, 'g' );

		if( this.started && this.started === filename && this.posNext ){
			return this.startTail( filename );
		}

		fs.stat( filename, (err, stats )=>{
			if( this.stopping ) return this.interrupt();
			
			if( err ){
				//debug('tryTail stat err', err);
				return this.emit('tailError', err);
			}
			
			
			let start = stats.size;
			if( typeof this.startPos === 'number' ){
				this.setCharPos( this.startPos );
			} else {
				if( this.startPos === 'start' ){
					if( this.cutoff && stats.size > this.cutoff ){
						this.emit('skip',start);
					} else {
						start = 0;
					}
				}

				this.setBytePos( start );
			}
			
			this.ino = stats.ino;
			
			this.getSecondary().then( secondary =>{
				if( filename === secondary ) this.emit('secondary', secondary);
				this.startTail( filename );
			});
		});

	}

	startTail( filename ){
		debug('startTail', filename, this.pos);

		this.onEndOfFile = this.onEndOfFileForTail;
		this.onLine = this.onLineForTail;
		
		if( !this.watcher ){
			const dirname = path.dirname( this.filename );
			//debug('watcher', dirname);
			this.watcher = fs.watch( dirname );
			
			this.watcher.on('change', this.checkDir.bind(this) );
			this.watcher.on('error', this.checkDirError.bind(this) );
		}
		
		// Do not wait in case we don't start at the end
		this.started = filename;
		this.getLine();
	}

	checkDirError( err ){
		debug('watcher', err);
		return this.onError( err );
	}

	checkDir(type, name ){
		debug(`Dir ${type}: ${name}`);

		// It will decide if it's time to switch over
		if( this.fd ){
			this.readable = true;
			return this.readStuff();
		}

		const basename = path.basename( this.filename );
		if( name !== basename ) return;

		this._stop();
		this.setBytePos(0);
		this.emit('restart','PRIMEFOUND');
		return this.start();
	}

	onError( err ){
		// handle all file and watcher errors
		debug('onError', err);
		this._stop(); // Do not wait
		
		if( this.listenerCount('error') ){
			this.emit( 'error', err );
		} else {
			if( this.force ){
				if( debug.enabled ){
					console.trace( err.toString() );
				} else {
					console.warn( err.toString() );
				}
			} else {
				console.warn("Tail object missing error listener. Force not used.");
				throw err;
			}
		}

	}
	
	async stop(){
		const self = this;

		self.stopping = self.started || self.filename;
		
		if( this.watcher ){
			this.watcher.off('change', this.checkDir.bind(this) );
			this.watcher.off('error', this.checkDirError.bind(this) );
			
			await new Promise( (resolve,reject) =>{
				this.watcher.on('error', err => reject(err) );				
				this.watcher.on('close', ()=>{
					delete this.watcher;
					resolve();
				});
				this.watcher.close();
			});
		}

		if( !self.starting ){
			self._stop();
			return true;
		}

		await new Promise( (resolve,reject) =>{

			function onEvent(){
				if( self.starting ){
					debug("still starting", self.starting);
					return;
				}

				self.off('error', onEvent );
				self.off('tailError', onEvent );
				self.off('ready', onEvent);

				self.stopping = null;
				self._stop();

				// debug('stop done');
				return resolve( self.started );
			}

			self.on('error', onEvent );
			self.on('tailError', onEvent );
			self.on('ready', onEvent );
			debug('stop', self.stopping);
		});

		self.stopping = null;
		return true;
	}

	interrupt(){
		debug('Interrupt', this.stopping);
		this.starting = null;
		this.emit('tailError', 'interrupt');
	}
	
	// Stops without waiting on current task
	_stop(){
		if( this.started ){
			debug(`Stops tail of ${this.started}`);
		}
		
		// if( this.watcher ) throw(new Error('can not stop watcher async'));

		if( this.fd ){
			if( this.fd !==	 'init' ){
				// debug("Closing fd " + this.fd);
				try {
					fs.closeSync( this.fd );
				} catch( err ){
					debug( "closing", err );
				}
			}
			delete this.fd;
		}
		
		this.pos = 0; // byte pos
		this.posLast = 0;
		this.posNext = 0;
		this.posSkip = 0;
		this.txt = '';

		this.started = null;
		this.reading = false;
		this.readable = false;
		this.stopping = null;
	}

	createReader(){
		if( this.fd ) return;
		// debug('createReader');
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

			this.unzip = null;
			if( this.started.match(/\.gz$/) ){
				const zlib = require('zlib');
				const unzip = this.unzip = zlib.createGunzip();

				// debug('unzipping', this.started);
				unzip.on('close', ()=> this.decode( null ) );
				unzip.on('end', ()=>{ this.unzip = null });
				unzip.on('data', chunk => this.decode( chunk ) );
				unzip.on('error', err => this.onLine( err ) );
			} else if( this.posSkip ){
				
			}

			//debug("Opened file as fd " + fd);
			this.emit('ready', fd);
			this.fd = fd;
			this.readStuff();
		});
	}

	readStuff(){
		if( !this.started ) return;
		this.createReader();
		if( this.fd === 'init' ) return;
		if( this.pos === 'init' ) return;
		if( this.reading ) return;
		this.reading = true;
		this.readable = false;

		// debug("Starts reading at " + this.pos, this.fd);
		if(!this.buf) this.buf = Buffer.alloc(this._bufsize);
		fs.read( this.fd, this.buf, 0, this._bufsize, this.pos,
						 this.append.bind(this) );
	}

	append(err, bytesRead, buf ){  //void

		if( err ){
			this.reading = false;
			debug('readStuff err', err );
			if( !this.started || !this.fd || this.stopping ) return;
			return this.onLine( err );
		}
		
		this.pos += bytesRead;

		if( this.unzip ){
			if( bytesRead === 0 ){
				this.decode( null );
				return this.unzip.end();
			}
			// debug('unzip bytes');
			this.unzip.write( buf.slice(0,bytesRead), undefined, ()=>{
				this.reading = false;
			});
			return;
		}

		this.reading = false;
		if( bytesRead === 0 ) return this.decode(null);
		return this.decode( buf.slice(0,bytesRead) );
	}

	decode( chunk, cnt ){
		// cnt is for debug
		// this.reading = false;

		if( chunk === null ){
			// debug('null chunk');
			this.txt += this.decoder.end(); // might have partial characters
			// this.reading = false;
			return this.onEndOfFile();
		}
		
		// debug('decode chunk', cnt, this.posLast );

		this.txt += this.decoder.write( chunk );
		this.getLine();
	}

	getLine(){
		// debug("Textbuffer: " + this.txt);
		const found = this.sepG.exec( this.txt );
		if( !found ) return this.readStuff();
		//debug( found );
		
		const line = this.txt.substr( 0, found.index );
		
		this.posLast = this.posNext;
		this.posNext += this.sepG.lastIndex;

		
		this.txt = this.txt.substr( this.sepG.lastIndex );
		this.sepG.lastIndex = 0;
		//debug( "Rest " + this.txt );
		// debug( `Line at ${this.posLast} »${line}«` );
		
		return this.onLine( null, line, this.posLast );
	}
	

	onEndOfFileForTail(){
		const self = this;
		// debug("End of file");
		if( !self.started ) return;

		debug("Should we switch the streams?");

		if( self.stopping ) return self.interrupt();
		
		const nextfile = self.backlog.pop();

		if( nextfile && nextfile !== self.filename  ){
			// We found a start in earlier file and are now catching up
			
			debug('continue catchup in the next file');
			self._stop();
			self.setBytePos(0);
			debug("starting new tail", nextfile);

			function onError( err ){
				offEvents();
				
				//debug("handle error on end of file for tail");
				if( self.stopping ) return self.interrupt();

				self.starting = null;
				self.onError( err );

				if( self.force ){
					self.starting = null;
					self.start();
				}
			}

			function onReady(){
				offEvents();
				debug('emitting restart');
				self.starting = null;
				self.emit('restart','CATCHUP');
			}

			function offEvents(){
				self.off('tailError', onError );
				self.off('error', onError );
				self.off('ready', onReady);
			}
			
			self.starting = nextfile;
			self.on('tailError', onError );
			self.on('error', onError );
			self.on('ready', onReady );
			
			self.tryTail( nextfile );
			
			return true;
		}
		
		self.reading = true;
		fs.stat(self.filename, (err,stat) =>{
			self.reading = false;
			if( err ){
				debug( 'onEndOfFileForTail stat', err );
			} else if( self.ino !== stat.ino ){
				if( stat.size ){
					debug("Switching over to the new file");
					self._stop();
					self.startPos = 'start';
					self.emit('restart','NEWPRIME');
					return self.start();
				}

				// Wait until it has something to read

				// Continue to emit that we reached eof				
			} else if( stat.size < self.pos ){
				debug("File truncated");
				self._stop();
				self.setBytePos(0);
				self.emit('restart','TRUNCATE');
				return self.start();
			}

			if( self.readable ) return self.readStuff();

			self.emit('eof', self.pos);
		});

	}

	onEndOfFileForFind(){
		// debug("End of file for next");
		const err = new Error("End of file");
		err.code = 'EOF';
		return this.onLine( err );
	}

	onLineForTail(err, line, pos){
		if( err ){
			return this.onError( err );
		}
		
		//debug( `Line ${pos}${this.posSkip?'/'+this.posSkip:''} »${line}«` +  (pos<this.posSkip?' skipped':'') +`(${this.pos})`);
		if( pos >= this.posSkip ){
			this.emit('line', line );
		}
		
		setImmediate( this.getLine.bind(this) );
	}
	
	//## TODO: use byte pos for all these so that we do not have to reset pos
	setCharPos( charPos ){
		if( charPos ) debug('setCharPos', charPos);
		//debug( 'curret', this.pos, this.posLast, this.posNext, this.posSkip );
		
		this.pos = 0; // byte pos
		this.posLast = 0;
		this.posNext = 0;

		this.startPos = charPos; // decoded pos
		if( charPos === 'start' ) charPos = 0;
		this.posSkip = charPos;
		this.txt = '';
	}

	setBytePos( pos ){
		if( pos ) debug('setBytePos', pos);

		if( pos === 'start' ) pos = 0;
		this.pos = pos; // byte pos
		this.posLast = 0;
		this.posNext = 0;

		this.startPos = 0; // decoded pos
		this.posSkip = 0;
		this.txt = '';
	}
	

}

module.exports = Tail;

// EOF
