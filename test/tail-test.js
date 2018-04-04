'use strict';
process.env.NODE_ENV = 'test';
const debug = require('debug')('test');
const chai = require('chai');
const expect = chai.expect;
const tmp = require('tmp');
const path = require('path');
const fs = require('fs');
const util = require('util');
const unlink = util.promisify(fs.unlink);
const open = util.promisify(fs.open);
const write = util.promisify(fs.write);
const rename = util.promisify(fs.rename);

const Tail = require('../tail');

const dir = tmp.dirSync();
//const dir = { name: __dirname };

const filename = path.join(dir.name,'file1.log');
const secondary = path.join(dir.name,'file1.log.1');

let cnt = 0;

function event( emitter, type ){
	return new Promise( resolve =>{
		emitter.once( type, resolve );
	});
}

after(async()=>{
	await unlink( filename ).catch(X=>{});
	await unlink( secondary ).catch(X=>{});
	dir.removeCallback();
});

describe('Tail default', function(){

	// Just in case the file exists from previous tests
	before(async ()=>{
		await unlink( filename ).catch(X=>{});
		await unlink( secondary ).catch(X=>{});
		return;
	});

//	afterEach(()=>{
//		if( tail1.stop ) tail1.stop();
//	});
	
	it("emits error ENOENT if missing", done =>{
		const tail1 = new Tail(filename);

		tail1.once('error', err=>{
			if( err.code == 'ENOENT' ) return done();
			tail1.stop();
			done( err );
		});
		tail1.once('ready', X=>{
			tail1.stop();
			done(new Error("failed to fail"));
		});		
		tail1.start();
	});

	it("emits ready if file exists", done =>{
		const tail1 = new Tail(filename);
		(async()=>{
			const fd = await open( filename, 'a');
			await write(fd, `Row ${++cnt}\n`);

			tail1.once('ready', fd=>{
				expect(fd).to.be.a('number');
				tail1.stop();
				fs.closeSync(fd);
				done();
			});
				
			tail1.start();
		})();
	});
	
	it("emits line on append", async function(){
		const tail1 = new Tail(filename);
		const nr = ++cnt;

		const fd = await open( filename, 'a');
		debug(`Appending to fd ${fd}`);
		
		await tail1.startP();
		
		await write(fd, `Row ${nr}\n`);
		const line = await tail1.nextLine();
		debug("Recieved line " + line );
		expect(line).to.be.eql(`Row ${nr}`);
		
		await tail1.stop();
		fs.closeSync(fd);
	});
});


describe('File rotation', function(){

	const tail1 = new Tail(filename);

	before( async ()=> await tail1.startP() );

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

async function appendRow( filename ){
	const nr = ++cnt;
	const row = `Row ${nr}`;
	const fd = await open( filename, 'a');
	debug(`Appending to fd ${fd}: ${row}`);
	await write(fd, row + "\n" );
	fs.closeSync(fd);
	return row;
}
