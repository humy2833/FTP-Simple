var fs = require('fs');
var fse = require('fs-extra');

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
		cb(err, err ? false : stats.isDirectory());
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
	fs.readdir(path, function(err, files){
		cb(err, files);
	});
}
FileUtil.lsSync = function(path){
	return fs.readdirSync(path);
}

module.exports = FileUtil;