'use strict';
process.env.NODE_ENV = 'test';
const debug = require('debug')('test');
const chai = require('chai');
const expect = chai.expect;
const tmp = require('tmp');
const path = require('path');
const fs = require('fs');
const util = require('util');
const open = util.promisify(fs.open);
const rename = util.promisify(fs.rename);
const zlib = require('zlib');

const Tail = require('../tail');

const dir = tmp.dirSync();
// const dir = { name: __dirname };
// debug('dir', dir.name);

const filename = path.join(dir.name,'file1.log');
const secondary = path.join(dir.name,'file1.log.1');

let cnt = 0;

function event( emitter, type ){
	return new Promise( resolve =>{
		emitter.once( type, resolve );
	});
}

after(async ()=>{
	try{ fs.unlinkSync( filename ) } catch(err){};
	try{ fs.unlinkSync( secondary ) } catch(err){};
});


describe('Tail default', function(){

	// Just in case the file exists from previous tests
	before(async ()=>{
		try{ fs.unlinkSync( filename ) } catch(err){};
		try{ fs.unlinkSync( secondary ) } catch(err){};
		return;
	});

	it("emits error ENOENT if missing", done =>{
		const tail1 = new Tail(filename);

		tail1.once('error', err=>{
			tail1.stop().then(()=>{
				if( err.code == 'ENOENT' ) return done();
				done( err );
			});
		});
		tail1.once('ready', X=>{
			tail1.stop().then( ()=>{
				done(new Error("failed to fail"));
			});
		});		
		tail1.start();
	});

	it("emits ready if file exists", done =>{
    debug('start emits ready if file exists');
		const tail1 = new Tail(filename);
		(async()=>{
			const fd_out = await open( filename, 'a');
			fs.writeSync(fd_out, `Row ${++cnt}\n`);

			tail1.once('ready', async fd_in =>{
				debug('got ready', fd_in );
				expect(fd_in).to.be.a('number');
				await tail1.stop();
				fs.closeSync(fd_out);
				done();
			});
				
			tail1.start();
		})();
	});
});

describe('Appending', function(){

	const t = {};

	// Just in case the file exists from previous tests
	before(async ()=>{
		try{ fs.unlinkSync( filename ) } catch(err){};
		try{ fs.unlinkSync( secondary ) } catch(err){};

		t.fd = await open( filename, 'a');
		debug(`Appending to fd ${t.fd}`);

		t.tail1 = new Tail(filename);
		await t.tail1.startP();

		return;
	});
	
	after(async ()=>{
		await t.tail1.stop();
		fs.closeSync(t.fd);
		fs.closeSync(t.fd2);
	});

	it("emits line on append", async function(){
		const nr = ++cnt;

		fs.writeSync(t.fd, `Row ${nr}\n`);
    //fs.fsyncSync(t.fd);
		const line = await t.tail1.nextLine();
		debug("Recieved line " + line );
		expect(line).to.be.eql(`Row ${nr}`);
	});

	it("emits line on second append", async function(){
		const nr = ++cnt;

		fs.writeSync(t.fd, `Row ${nr}\n`);
    //fs.fsyncSync(t.fd);
		const line = await t.tail1.nextLine();
		debug("Recieved line " + line );
		expect(line).to.be.eql(`Row ${nr}`);
	});

	it("emits line after append from other source", async function(){
		const nr = ++cnt;

		t.fd2 = await open( filename, 'a');
		debug(`Appending to fd ${t.fd2}`);

		fs.writeSync(t.fd2, `Row ${nr}\n`);
    //fs.fsyncSync(t.fd2);
		const line = await t.tail1.nextLine();
		debug("Recieved line " + line );
		expect(line).to.be.eql(`Row ${nr}`);
	});

	it("emits line after append from first source again", async function(){
		const nr = ++cnt;

		fs.writeSync(t.fd, `Row ${nr}\n`);
    //fs.fsyncSync(t.fd);
		const line = await t.tail1.nextLine();
		debug("Recieved line " + line );
		expect(line).to.be.eql(`Row ${nr}`);
	});
});

describe('Missing primary', function(){
	let tail1;

	before( ()=>{
		try{ fs.unlinkSync( filename ) } catch(err){};
		try{ fs.unlinkSync( secondary ) } catch(err){};
		tail1 = new Tail(filename);
	});

	after( ()=> tail1.stop() );

	it('starts in secondary', async function(){
		await appendRow( filename );
		await rename( filename, secondary );
		await tail1.startP();
		const row1 = await appendRow( secondary );
		const line = await tail1.nextLine();
		debug("Recieved line " + line );
		expect(line).to.be.eql(row1);		
	});
});

describe('File rotation', function(){

	let tail1;

	before( async ()=>{
		try{ fs.unlinkSync( filename ) } catch(err){};
		try{ fs.unlinkSync( secondary ) } catch(err){};

		await appendRow( filename );
		await appendRow( filename );

		tail1 = new Tail(filename);
		await tail1.startP();
	});

	after( ()=> tail1.stop() );
	
	it("emits line on append", async function(){
		
		const row = await appendRow( filename );
		const line = await tail1.nextLine();
		expect(line).to.be.eql( row );
	});

	it("keeps reading after file rename", async function(){
		debug('rotating file');
		await rename( filename, secondary );

		const row = await appendRow( secondary );
		const line = await tail1.nextLine();
		expect(line).to.be.eql( row );
	});

	it("keeps reading after a new primary file are created", async function(){
		const fdNew = await open( filename, 'w');
		fs.closeSync(fdNew);

		const row = await appendRow( secondary );
		const line = await tail1.nextLine();
		expect(line).to.be.eql( row );
	});

	it("switches to the primary file when there is new content", async function(){
		const row = await appendRow( filename );
		const line = await tail1.nextLine();
		expect(line).to.be.eql( row );
	});

});

describe('Find start', function(){

	let tail1;
	const lines = [];
	let fd, rowcnt = 0;
	
	function fname(no){
		return path.join(dir.name, "multi.log" + (no?`.${no}`:'') );
	}
	
	function rowtext(){
		return `Row ${++rowcnt}\n`;
	}

	function onLine( line ){
		if( ! line.match(/^Row /) ) return;
		lines.push(line);
		debug('gotline', line);
	}
	
	before( async ()=>{
		tail1 = new Tail( fname(0) );

		function zip(no){
			return new Promise( (resolve,reject)=>{
				const name = fname(no);
				const gzip = zlib.createGzip();
				const inp = fs.createReadStream( name );
				const out = fs.createWriteStream( `${name}.gz` );
				const writer = inp.pipe(gzip).pipe(out);
				writer.on('error', reject );
				writer.on('close', resolve );
			});
		}

		fd = await open( fname(4), 'w');
		fs.writeSync(fd, "stuff\n");
		fs.writeSync(fd, rowtext());
		fs.writeSync(fd, rowtext());
		fs.writeSync(fd, rowtext());

		fd = await open( fname(3), 'w');
		fs.writeSync(fd, "stuff\n");
		fs.writeSync(fd, rowtext());
		fs.writeSync(fd, rowtext());
		fs.writeSync(fd, rowtext());

		fd = await open( fname(2), 'w');
		fs.writeSync(fd, "stuff\n");
		fs.writeSync(fd, rowtext());
		fs.writeSync(fd, "stuff\n");

		fd = await open( fname(1), 'w');
		fs.writeSync(fd, "stuff\n");

		fd = await open( fname(0), 'w');
		fs.writeSync(fd, "\u261E \u26F9 \u2615 stop\n");
		fs.writeSync(fd, rowtext());

		//fs.closeSync(fd);

		await zip(2); fs.unlinkSync( fname(2) );
		await zip(3); fs.unlinkSync( fname(3) );
		await zip(4); fs.unlinkSync( fname(4) );

		tail1.on('line', onLine );
	});

	after(async ()=>{
		debug('stop tail1');
		tail1.off('line', onLine );
		await tail1.stop();
		try{ fs.unlinkSync( fname(4)+".gz" ) } catch(err){};
		try{ fs.unlinkSync( fname(3)+".gz" ) } catch(err){};
		try{ fs.unlinkSync( fname(2)+".gz" ) } catch(err){};
		try{ fs.unlinkSync( fname(1) ) } catch(err){};
		try{ fs.unlinkSync( fname(0) ) } catch(err){};		
	});


	let found = false;
	it("finds start in older file", async function(){
		const target = 5;
		debug('looking for', target );
		found = await tail1.findStart( /^Row (\d+)$/, str => target - str );
		expect(found).to.be.true;
	});

	it("processes files in order", function( done ){
		tail1.once('eof', ()=>{
			expect(lines).to.eql(['Row 5','Row 6','Row 7','Row 8']);
			done();
		});
	});

	it("tails latest file", function( done ){
		tail1.once('line', line =>{
			expect(line).to.eq('Row 9');
			done();
		});
		fs.writeSync(fd, rowtext());
	});

	it("restarts at right position", function( done ){
		const charPos = tail1.posNext;
		fs.writeSync(fd, rowtext());
		fs.writeSync(fd, rowtext());

		(async()=>{
			await tail1.stop();
			fs.closeSync(fd);
			
			tail1.startPos = charPos; // Explicitly not at end of file
			tail1.once('line', line =>{
				expect(line).to.eq('Row 10');
				done();
			});

			tail1.start();
		})();
	});
});

describe('Find start in secondary', function(){

	let tail1;
	const lines = [];
	let fd, rowcnt = 0, eof;
	
	function fname(no){
		return path.join(dir.name, "multi.log" + (no?`.${no}`:'') );
	}
	
	function rowtext(){
		return `Row ${++rowcnt}\n`;
	}

	before( async ()=>{
		tail1 = new Tail( fname(0) );
		try{ fs.unlinkSync( fname(0) ) } catch(err){};
		fd = await open( fname(1), 'w');
		fs.writeSync(fd, "stuff\n");
		fs.writeSync(fd, rowtext());
		fs.writeSync(fd, rowtext());
		fs.writeSync(fd, rowtext());

		tail1.force = true;
		tail1.on('error', err=>{ debug(err) }); // Ignore error

		tail1.once('eof', ()=>{
			eof = true;
			debug('EOF');
		});

	});

	after(async ()=>{
		debug('stop tail1');
		await tail1.stop().catch(err=>debug('caught'))
		try{ fs.unlinkSync( fname(1) ) } catch(err){};
		try{ fs.unlinkSync( fname(0) ) } catch(err){};		
	});


	let found = false;
	it("finds start in older file", async function(){
		const target = 2;
		found = await tail1.findStart( /^Row (\d+)$/, str => target - str ).catch(err=>debug('caught2'));
		expect(found).to.be.true;
	});

	it("tails latest file", function( done ){
		function onLine( line ){
			if( line !== "Row 5" ) return;
			tail1.off( 'line', onLine );
			done();
		}

		tail1.on('line', onLine );
		fs.writeSync(fd, rowtext());
		fs.writeSync(fd, rowtext());
	});

	it("stay on latest file", function( done ){
		function onEof(){
			fs.writeSync(fd, rowtext());
			tail1.once('line', line =>{
				expect(line).to.eql("Row 6");
				done();
			});
		}

		if( eof ) onEof();
		else tail1.once('eof', onEof );
	});

	it("switches to the primary file when there is new content", async function(){
		const row = await appendRow( fname(0) );
		const line = await tail1.nextLine();
		expect(line).to.be.eql( row );
	});

	
});


describe('Find start between files', function(){

	let tail1;
	const lines = [];
	let fd, rowcnt = 0, eof;
	
	function fname(no){
		return path.join(dir.name, "multi.log" + (no?`.${no}`:'') );
	}
	
	function rowtext(){
		return `Row ${++rowcnt}\n`;
	}

	before( async ()=>{
		tail1 = new Tail( fname(0) );
		fd = await open( fname(1), 'w');
		fs.writeSync(fd, "stuff\n");
		fs.writeSync(fd, rowtext());
		rowcnt += 3;
		fs.writeSync(fd, rowtext());

		rowcnt += 3;

		fd = await open( fname(0), 'w');
		fs.writeSync(fd, rowtext());
		fs.writeSync(fd, rowtext());
		rowcnt += 3;
		fs.writeSync(fd, rowtext());
		fs.writeSync(fd, "stuff\n");

		tail1.on('error', err=>{}); // Ignore error

		tail1.once('eof', ()=>{
			eof = true;
			debug('EOF');
		});

	});

	after(async ()=>{
		debug('stop tail1');
		await tail1.stop().catch(err=>debug('caught'))
		try{ fs.unlinkSync( fname(1) ) } catch(err){};
		try{ fs.unlinkSync( fname(0) ) } catch(err){};		
	});


	let found = false;
	it("finds next awailible row", async function(){
		const target = 7;

		const nextLine = new Promise( (resolve,reject)=>{
			tail1.once('line', line =>{
				debug('gotline', line);
				resolve( line );
			});
		});
		
		const found = await tail1.findStart( /^Row (\d+)$/, str => target - str ).catch(err=>debug('caught2', err));
		expect(found).to.be.true;
		const latestLine = await nextLine;
		expect(latestLine).to.eql('Row 9');
	});
	
});


describe('Find start between files with more in queue', function(){

	let tail1;
	const lines = [];
	let fd, rowcnt = 0, eof;
	
	function fname(no){
		return path.join(dir.name, "multi.log" + (no?`.${no}`:'') );
	}
	
	function rowtext(){
		return `Row ${++rowcnt}\n`;
	}

	before( async ()=>{
		tail1 = new Tail( fname(0) );
		fd = await open( fname(2), 'w');
		fs.writeSync(fd, "stuff\n");
		fs.writeSync(fd, rowtext());
		fs.writeSync(fd, rowtext());

		fd = await open( fname(1), 'w');
		fs.writeSync(fd, "stuff\n");
		fs.writeSync(fd, rowtext());
		rowcnt += 3;
		fs.writeSync(fd, rowtext());

		rowcnt += 3;

		fd = await open( fname(0), 'w');
		fs.writeSync(fd, rowtext());
		fs.writeSync(fd, rowtext());
		rowcnt += 3;
		fs.writeSync(fd, rowtext());
		fs.writeSync(fd, "stuff\n");

		tail1.on('error', err=>{}); // Ignore error

		tail1.once('eof', ()=>{
			eof = true;
			debug('EOF');
		});

	});

	after(async ()=>{
		debug('stop tail1');
		await tail1.stop().catch(err=>debug('caught'))
		try{ fs.unlinkSync( fname(2) ) } catch(err){};
		try{ fs.unlinkSync( fname(1) ) } catch(err){};
		try{ fs.unlinkSync( fname(0) ) } catch(err){};		
	});


	let found = false;
	it("finds next awailible row", async function(){
		const target = 9;
		debug('looking for', target );

		const nextLine = new Promise( (resolve,reject)=>{
			tail1.once('line', line =>{
				debug('gotline', line);
				resolve( line );
			});
		});
		
		const found = await tail1.findStart( /^Row (\d+)$/, str => target - str ).catch(err=>debug('caught2', err));
		expect(found).to.be.true;
		const latestLine = await nextLine;
		expect(latestLine).to.eql('Row 11');
	});
	
});


describe('Custom line-split', function(){

	let tail1;
	const lines = [];
	let fd, rowcnt = 0;

	//tail1.on('error', err=>{console.warn("OUCH")}); // Ignore error
	
	function rowtext(){
		return `Multiline\nRow ${++rowcnt}\n--end_of_rec--\n`;
	}

	before( async ()=>{
		tail1 = new Tail( filename );

		fd = await open( filename, 'w');
		fs.writeSync(fd, rowtext());
		fs.writeSync(fd, rowtext());
		fs.writeSync(fd, rowtext());
	});

	after(async ()=>{
		debug('stop tail1');
		await tail1.stop();
	});


	it("finds line with split spread over chunks", function( done ){
		tail1.once('line', line =>{
			expect(line).to.eq("Multiline\nRow 1");
			done();
		});
		tail1.startPos = 'start';
		tail1.sep = /\r?\n--end_of_rec--\r?\n/;
		tail1._bufsize = 20; // test match spread over chunks
		tail1.start();

		debug('bufsize', tail1._bufsize);

	});
});


async function appendRow( filename ){
	const nr = ++cnt;
	const row = `Row ${nr}`;
	const fd = await open( filename, 'a');
	debug(`Appending to fd ${fd}: ${row}`);
	fs.writeSync(fd, row + "\n" );
	fs.closeSync(fd);
	return row;
}
