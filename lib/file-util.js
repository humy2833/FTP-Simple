var fs = require('fs');
var fse = require('fs-extra');
var loop = require('easy-loop');
var pathUtil = require('./path-util');

function FileUtil(){}

/**
 * 파일, 디렉토리가 존재하는가?
 * @param path
 */
FileUtil.exist = function(path, cb){
	fs.stat(path, function(err, stats){
		cb(err ? false : true);
	});
}
FileUtil.existSync = function(path){
	try{
		fs.statSync(path);
		return true;
	}catch(e){return false;}
}
/**
 * 디렉토리인가?
 * @param path
 */
FileUtil.isDir = function(path, cb){
	fs.stat(path, function(err, stats){
		if(cb)cb(err, err ? false : stats.isDirectory());
	});
}
FileUtil.isDirSync = function(path){
	try{
		var stats = fs.statSync(path);
		return stats && stats.isDirectory();
	}catch(e){return false;}
}
/**
 * 디렉토리 생성(기본 : -r)
 * @param path
 * @param cb
 */
FileUtil.mkdir = function(path, cb){
	fse.mkdirs(path, function(err) {
		cb(err);
	});
}
FileUtil.mkdirSync = function(path){
	fse.mkdirsSync(path);
}
/**
 * 하위 파일, 폴더 리스트 반환
 * @param path
 * @param cb
 */
FileUtil.ls = function(path, cb){
	var self = this;
	var list = [];
	fs.readdir(path, function(err, files){
		if(err)	cb(err, list);
		else 
		{	
			loop(files, 100, function(i, value, next){
				self.stat(pathUtil.join(path, value), function(stats){
					if(stats) list.push(stats);
					next();
				});
			}, function(err){
				if(cb) cb(err, list);
			});
		}
	});
}
FileUtil.lsSync = function(path){
	var list = [];
	try{
		var files = fs.readdirSync(path);
		for(var i=0; i<files.length; i++)
		{
			var stats = this.statSync(pathUtil.join(path, files[i]));
			if(stats) list.push(stats);
		}
	}catch(e){}
	return list;
	
}
function makeStat(path, stats){
	return {
		name : pathUtil.getFileName(path)
		,type : stats.isDirectory() ? "d" : "f"
		,size : stats.size
		,date : stats.mtime
	};
}
FileUtil.stat = function(path, cb){
	var o;
	fs.stat(path, function(err, stats){
		if(err) cb(o);
		else
		{
			cb(makeStat(path, stats));
		}
	});
}
FileUtil.statSync = function(path){
	var o, stats;
	try{
		stats = fs.statSync(path);
		o = makeStat(path, stats);
	}catch(e){}
	return o;
}

module.exports = FileUtil;