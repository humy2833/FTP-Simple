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
	this.exist(path, function(result){
		if(!result)
		{
			fse.mkdirs(path, function(err) {
				if(cb)cb(err);
			});
		}
		else if(cb)cb();
	});
}
FileUtil.mkdirSync = function(path){
	if(!this.existSync(path)) fse.mkdirsSync(path);
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
		,path : path
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
FileUtil.writeFile = function(path, data, cb){
	fs.writeFile(path, data, function(err){
		if(cb)cb(err);
	});
}
FileUtil.writeFileSync = function(path, data){
	return fs.writeFileSync(path, data);
}
/**
 * 파일, 폴더 삭제
 */
FileUtil.rm = function(path, cb){
	// fse.remove(path, function(err){
	// 	if(cb)cb();
	// });
	
	var self = this;
	path = pathUtil.normalize(path);	
	this.exist(path, function(result){
		if(result)
		{
			self.isDir(path, function(err, result){
				if(result)
				{
					self.ls(path, function(err, files){
						loop(files, function(i, value, next){
							self.rm(pathUtil.join(path, value.name), function(){
								next();
							});
						}, function(err){
							fs.rmdir(path, function(err){
								if(cb) cb();
							});
						});
					});
				}
				else
				{
					fs.unlink(path, function(){
						if(cb)cb();
					});
				}
			});
		}
		else if(cb)cb();
	});

}
/**
 * 파일, 폴더 삭제 동기버전
 */
FileUtil.rmSync = function(path){
  //fse.removeSync(path);
	
	path = pathUtil.normalize(path);	
	if(this.existSync(path))
	{
		if(this.isDirSync(path))
		{
			var files = this.lsSync(path);
			for(var i=0,len=files.length; i<len; i++)
			{
				this.rmSync(pathUtil.join(path, files[i].name));
			}
			fs.rmdirSync(path);
		}
		else
		{
			fs.unlinkSync(path);
		}
	}
	
}
module.exports = FileUtil;