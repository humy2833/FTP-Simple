// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
var vscode = require('vscode');
var fs = require('fs');
var filesize = require('filesize');
var Path = require('path');
var EasyFTP = require('easy-ftp');
var outputChannel = null;
var root = null;
// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
function activate(context) {

    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated
   
    // var isWin = /^win/.test(process.platform);
    // var appDir = Path.dirname(require.main.filename);//c:\Program Files (x86)\Microsoft VS Code\resources\app\out
    // console.log(process.platform);

    var orgRoot = vscode.workspace.rootPath;
    

    if(orgRoot)
    {
      //현재 열린 프로젝트 폴더 풀경로
      root = correctPath(orgRoot);
      console.log("root : " + root);
      //vscode.window.showInformationMessage('Project Folder not exist.');
    }

    outputChannel = vscode.window.createOutputChannel("ftp");  
    // vscode.window.setStatusBarMessage("실행중");
    // vscode.workspace.onDidSaveTextDocument(function(event){
    //   console.log(event.fileName);
    // });
    // The command has been defined in the package.json file
    // Now provide the implementation of the command with  registerCommand
    // The commandId parameter must match the command field in package.json
    var ftpEdit = vscode.commands.registerCommand('ftp.edit', function () {
        // The code you place here will be executed every time your command is executed
        
        //확장 설정 가져오기(hello.abcd 일때);
        //console.log(JSON.stringify(vscode.workspace.getConfiguration('hello')));
        // Display a message box to the user
        //console.log(readConfig());
        
        //설정파일 열어서 에디터에 보여주기
        showEditor(initConfig());        
        
        //상단 알림바
        //vscode.window.showInformationMessage('Hello World!');
    });
    var ftpDownload = vscode.commands.registerCommand('ftp.download', function () {
      getFTPRoot(function(firstPath, ftpConfig){
        var ftp = creatFTP(ftpConfig); 

        function getSubList(path, cb){
          path = correctPath(path);
          ftp.ls(path, function(err, list){
            if(!err) output("cd " + path);
            var arr = [];
            for(var i in list)
            {
              arr.push({label:"[" + list[i].type.toUpperCase() + "] " + list[i].name, description:"DATE : "+list[i].date.toLocaleString() + ", SIZE : " + filesize(list[i].size)});
            }
            arr.sort(function(a,b){
              if(a.label < b.label) return -1;
              if(a.label > b.label) return 1;
              return 0;
            });
            if(arr.length > 0) arr = [{label:"## All file download from current path ##", description:pathjoin(path, "/**")}].concat(arr);
            if(path != firstPath) arr = [{label:"..", description:"Parent folder"}].concat(arr); 
            vscode.window.showQuickPick(arr, {placeHolder:"Select download file or path"}).then(function(name){
              if(!name)
              {
                ftp.close();
                return;
              }
              if(name.label.indexOf("## All file download") > -1)
              {
                really(function(){
                  if(cb) cb(pathjoin(path, "/**"));
                  else ftp.close();
                }, function(){
                  getSubList(path, cb);
                });
              }
              else if(name.label.indexOf("[D]") > -1)
              {
                getSubList(pathjoin(path, name.label.substring(4)), cb);
              }
              else if(name.label == "..")
              {
                getSubList(getParentName(path), cb);
              }
              else
              {                  
                if(cb)cb(pathjoin(path, name.label.substring(4)));
                else ftp.close();
              }
            });              
          });
        }
        getSubList(firstPath, function(path){
          //console.log(firstPath);
          var remotePath = path;
          if(firstPath != "/")
          {
            var n = firstPath.length;
            remotePath = path.substring(firstPath.substring(n-1) == "/" ? n - 1 : n);
          }
          if(/\/\*\*$/.test(path))
          {
            //console.log(root, remotePath.replace(/\*\*$/, ''));
            ftp.download(path, root + remotePath.replace(/\*\*$/, ''), function(){
              ftp.close();
            });
          }
          else
          {              
            var localPath = root + remotePath;
            if(fs.stat(localPath, function(err, stats){
              if(stats)
              {
                vscode.window.showQuickPick([{label:"Overwrite"}
                , {label:"Save new file", description:"create new file. Not overwrite"}], {placeHolder:"Select save type"}).then(function(name){
                  if(!name) ftp.close();
                  else if(name.label == "Overwrite")
                  {                    
                    ftp.download(path, localPath, function(){
                      ftp.close();
                    });
                  }
                  else
                  {
                    var o = Path.parse(localPath);
                    localPath = pathjoin(o.dir, o.name + "_" + new Date().getTime() + o.ext);
                    ftp.download(path, localPath, function(){
                      ftp.close();
                    });
                  }
                });
              }
              else
              {
                ftp.download(path, localPath, function(err){
                  if(err) console.log(err);
                  ftp.close();
                });
              }
            }));
          }            
        });
      });
    });
    
    var ftpUpload = vscode.commands.registerCommand('ftp.upload', function () { 
      getFTPRoot(function(path, ftpConfig){
        //프로젝트 폴더명          
        // var folderName = getFileName(root);     
        //현재 에디터에 열린 파일 풀경로
        var activeFilePath = correctPath(getActiveFilePath());
        console.log(activeFilePath, root);
        if(activeFilePath.indexOf(root) !== 0)
        {
          vscode.window.showInformationMessage('The current file is not included in the project.');
          return;
        }

        // var activeFileName = getFileName(activeFilePath);
        var activeParentName = getParentName(activeFilePath);
        vscode.window.showQuickPick([{label:"Current File", description:activeFilePath.substring(root.length) + " → " + pathjoin(path, activeFilePath.substring(root.length))}
          , {label:"Parent Folder", description:activeParentName.substring(root.length) + " → " + getParentName(pathjoin(path, activeFilePath.substring(root.length)))}
          , {label:"Project file all", description:"/**" + " → " + pathjoin(path, "/**")}], {placeHolder:"Select upload file or path"})
        .then(function(name){
          if(!name) return;
          var remotePath = pathjoin(path, activeFilePath.substring(root.length));
          if(name.label == "Parent Folder")
          {
            activeFilePath = pathjoin(getParentName(activeFilePath), "/**");
            remotePath = getParentName(remotePath);
            really(run);
          }
          else if(name.label == "Project file all")
          {
            activeFilePath = pathjoin(root, "/**");
            remotePath = path;
            really(run);
          }
          else run();

          function run(){
            var ftp = creatFTP(ftpConfig, function(){
              ftp.upload(activeFilePath, remotePath, function(){
                ftp.close();
              });
            });
          }
        });
      });
    });

    context.subscriptions.push(ftpEdit);
    context.subscriptions.push(ftpDownload);
    context.subscriptions.push(ftpUpload);
}
exports.activate = activate;

// this method is called when your extension is deactivated
function deactivate() {
}
exports.deactivate = deactivate;

function really(execb, cancb, esc){
  vscode.window.showQuickPick(["Cancel", "Execute"], {placeHolder:"Really?"}).then(function(name){
    if(name == "Execute" && execb) execb();
    else if(!name || name == "Cancel" && cancb) cancb();
  });
}
function creatFTP(ftpConfig, cb){
  var ftp = new EasyFTP();
  output("FTP Connecting... : " + ftpConfig.host);
  ftp.connect(ftpConfig);
  ftp.on("open", function(){
    output("FTP open!!");
    if(cb) cb();
  });
  ftp.on("close", function(){
    output("FTP close!!");
  });
  ftp.on("error", function(err){
    output(err);
  });
  ftp.on("upload", function(path){
    output("Uploaded : " + path);
  });
  ftp.on("download", function(path){
    output("Downloaded : " + path);
  });
  return ftp;
}
function pathjoin(a, b){
  var p = "";
  for(var i=0; i<arguments.length; i++)
  {
    p = Path.join(p, arguments[i]);
  }
  return correctPath(p);
}
function getConfigPath(){
  var folder = process.env.APPDATA || (process.platform == 'darwin' ? process.env.HOME + '/Library/Application Support' : '/var/local');
  return Path.join(folder, "Code/User/ftp_config.json");
}
function initConfig(){
  var path = getConfigPath();
  if(!existConfig())
  {
    fs.writeFileSync(path, JSON.stringify([{name:"ftp1", host:"", port:21, type:"ftp", username:"", password:"", path:["/"]}], null, "\t"));
  }
  return path;
}
function existConfig(){
  return fs.existsSync(getConfigPath());
}
function getConfig(){
  if(existConfig())
  {
    var path = getConfigPath();
    try{
      return JSON.parse(fs.readFileSync(path).toString());
    }catch(e){}
  }
  return {};
}
function showEditor(path){
  if(!fs.existsSync(path))
  {
    alertBreakConfig()
    vscode.window.showInformationMessage('Config file is not exist.');
  }
  else
  {
    vscode.workspace.openTextDocument(initConfig()).then(function (doc) {
        vscode.window.showTextDocument(doc);
    });  
  }
}
function getFTPNames(){
  var config = getConfig();
  var names = [];
  for(var i in config)
  {
    names.push(config[i].name || config[i].host || "undefined");
  }
  return names;
}
function correctPath(path){
  return path.replace(/\\/g, '/').replace(/\/+/g, '/');
}
function getFTPConnectInfo(name){
  var config = getConfig();
  for(var i in config)
  {
    if(config[i].name == name)
    {
      return config[i];
    }
  }
  return {};
}
function getActiveFilePath(){
  return vscode.window.activeTextEditor.document.fileName;
}
function getFileName(p){
  return Path.basename(p);
}
function getParentName(p){
  return Path.dirname(p);
}
function output(str){
  outputChannel.appendLine("[" + getNow() + "] " + str);
}
function getRemoteDirectoryList(ftp, path, cb){
  ftp.ls(path, function(err, list){
    cb(list);
  });
}
function getFTPRoot(cb){
  var ftps = getFTPNames();
  if(ftps.length == 0)
  {
    vscode.window.showInformationMessage('Check config file.');
    return;
  }
  //설정에 있는 FTP 목록 가져와서 보여주기
  vscode.window.showQuickPick(ftps, {placeHolder:"Select FTP server"})
  //목록에서 하나 선택했다면
  .then(function(name) {
    if(!name)
    {
      //vscode.window.showInformationMessage('Config file is not exist.');
      return;
    }
    //console.log(name);
    //설정파일에 설정한 웹루트경로 가져오기
    var ftpConfig = getFTPConnectInfo(name);
    var roots = ftpConfig.path;
    var isArr = roots instanceof Array;
    if(!roots || isArr && roots.length == 0)
    {
      isArr = true;
      roots = ["/"];
    }
    if(isArr && roots.length === 1)
    {
      cb(roots[0], ftpConfig);
    }
    else if(typeof roots === 'string')
    {
      cb(roots, ftpConfig);
    }
    else //여러개라면 선택창으로 보여주기
    {
      vscode.window.showQuickPick(roots, {placeHolder:"Select remote root path"}).then(function(path){
        if(!path) return;
        else cb(path, ftpConfig);
      });
    }
  });
}
function getNow(){
  var d = new Date();
  return d.getFullYear() + "-" + lpad(d.getMonth()) + "-" + lpad(d.getDate()) + " " + lpad(d.getHours()) + ":" + lpad(d.getMinutes()) + ":" + lpad(d.getSeconds()); 
}
function lpad(n){
  return n < 10 ? "0" + n : n;
}