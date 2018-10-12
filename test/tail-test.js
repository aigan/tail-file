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
//const dir = { name: __dirname };
//debug('dir', dir.name);

const filename = path.join(dir.name,'file1.log');
const secondary = path.join(dir.name,'file1.log.1');

let cnt = 0;

function event( emitter, type ){
	return new Promise( resolve =>{
		emitter.once( type, resolve );
	});
}

after(async()=>{
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
			tail1.stop();
			if( err.code == 'ENOENT' ) return done();
			done( err );
		});
		tail1.once('ready', X=>{
			tail1.stop();
			done(new Error("failed to fail"));
		});		
		tail1.start();
	});

	it("emits ready if file exists", done =>{
        debug('start emits ready if file exists');
		const tail1 = new Tail(filename);
		(async()=>{
			const fd = await open( filename, 'a');
			fs.writeSync(fd, `Row ${++cnt}\n`);

			tail1.once('ready', fd=>{
				expect(fd).to.be.a('number');
				tail1.stop();
				fs.closeSync(fd);
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
	
	after(async()=>{
		await t.tail1.stop();
		fs.closeSync(t.fd);	
		fs.closeSync(t.fd2);	
	});

	it("emits line on append", async function(){
		const nr = ++cnt;

		fs.writeSync(t.fd, `Row ${nr}\n`);
    fs.fsyncSync(t.fd);
		const line = await t.tail1.nextLine();
		debug("Recieved line " + line );
		expect(line).to.be.eql(`Row ${nr}`);
	});

	it("emits line on second append", async function(){
		const nr = ++cnt;

		fs.writeSync(t.fd, `Row ${nr}\n`);
    fs.fsyncSync(t.fd);
		const line = await t.tail1.nextLine();
		debug("Recieved line " + line );
		expect(line).to.be.eql(`Row ${nr}`);
	});

	it("emits line after append from other source", async function(){
		const nr = ++cnt;

		t.fd2 = await open( filename, 'a');
		debug(`Appending to fd ${t.fd2}`);

		fs.writeSync(t.fd2, `Row ${nr}\n`);
        fs.fsyncSync(t.fd2);
		const line = await t.tail1.nextLine();
		debug("Recieved line " + line );
		expect(line).to.be.eql(`Row ${nr}`);
	});

	it("emits line after append from first source again", async function(){
		const nr = ++cnt;

		fs.writeSync(t.fd, `Row ${nr}\n`);
        fs.fsyncSync(t.fd);
		const line = await t.tail1.nextLine();
		debug("Recieved line " + line );
		expect(line).to.be.eql(`Row ${nr}`);
	});
});

describe('Missing primary', function(){
	const tail1 = new Tail(filename);

	before(async ()=>{
		try{ fs.unlinkSync( filename ) } catch(err){};
		try{ fs.unlinkSync( secondary ) } catch(err){};
	});

	after( async ()=> tail1.stop() );

	it('starts in secondary', async function(){
		await appendRow( filename );
		await rename( filename, secondary );
		await tail1.start();
		const row1 = await appendRow( secondary );
		const line = await tail1.nextLine();
		debug("Recieved line " + line );
		expect(line).to.be.eql(row1);		
	});
});

describe('File rotation', function(){

	const tail1 = new Tail(filename);

	before( async ()=>{
		try{ fs.unlinkSync( filename ) } catch(err){};
		try{ fs.unlinkSync( secondary ) } catch(err){};

		await appendRow( filename );
		await appendRow( filename );

		await tail1.startP();
	});

	after( async ()=> tail1.stop() );
	
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

xdescribe('Find start', function(){

	const tail1 = new Tail( filename(0) );

	function filename(no){
		return path.join(dir.name, "multi.log" + (no?`.${no}`:'') );
	}
	
	before( async ()=>{
		let fd, rowcnt = 0;

		function rowtext(){
			return `Row ${++rowcnt}\n`;
		}

		function zip(no){
			return new Promise( (resolve,reject)=>{
				const name = filename(no);
				const gzip = zlib.createGzip();
				const inp = fs.createReadStream( name );
				const out = fs.createWriteStream( `${name}.gz` );
				const writer = inp.pipe(gzip).pipe(out);
				writer.on('error', reject );
				writer.on('close', resolve );
			});
		}

		fd = await open( filename(3), 'w');
		fs.writeSync(fd, "stuff\n");
		fs.writeSync(fd, rowtext());
		fs.writeSync(fd, rowtext());
		fs.writeSync(fd, rowtext());

		fd = await open( filename(2), 'w');
		fs.writeSync(fd, "stuff\n");
		fs.writeSync(fd, rowtext());
		fs.writeSync(fd, "stuff\n");

		fd = await open( filename(1), 'w');
		fs.writeSync(fd, "stuff\n");

		fd = await open( filename(0), 'w');
		fs.writeSync(fd, "stuff\n");

		fs.closeSync(fd);
		await zip(2);
		fs.unlinkSync( filename(2) );
		
		await zip(3);
		fs.unlinkSync( filename(3) );
	});

	it("finds start in older file", async function(){

		const target = 2;
		await tail1.findStart( /^Row (\d+)$/, str => target - str );

		//tail1.searchFiles = [this.secondary];

		for( let name of tail1.searchFiles ){
			console.log('searching', name);
		}

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
