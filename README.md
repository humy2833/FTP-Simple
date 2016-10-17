##Function

- Directly **Open**, **Edit** and **Save** on server files.
- **Save** the **local file** or **directory** to **server**(=upload and backup option)
- **Download** the file or directory from ftp server.
- **Create** a **directory** on the remote server directly.
- **Delete** **directory**(recursive) and **files** directly from the server.
- **Compare** a local file server file.
- ** Remote directory open to workspace** (Beta version)

##Available commands
* config - Set the ftp connection information.
* create directory - Create a directory on ftp server.
* open - Open the file directly from ftp server and when you save upload it to the ftp server.
* save - File or directory upload to ftp server.(Available from the context menu)
* download - Download the file or directory from ftp server to the workspace.
* delete - Delete the file or directory directly from ftp server.
* diff - Compare a local file server file.
* Remote directory open to workspace - (Beta version) Open the direcotry directly on workspace from ftp server.
 - Available function
 -- File Save
 -- 'Delete' of Context menu 
	
                                     
																		 
 
##Startup Settings
1. Press 'F1'  
2. Enter 'ftp-simple' 
3. Pick 'CONFIG' 
4. Enter ftp connection information and save

##Config setting example
See the [easy-ftp](https://www.npmjs.com/package/easy-ftp) details.

* **name** - _string_	- Display name.
* **host** - _string_	- server domain or ip.
* **port** - _number_	- (option) port (default : 21)
* **type** - _string_	- (option) ftp type. 'ftp' or 'sftp' (default : 'ftp')
* **username** - _string_	- username for authentication.
* **password** - _string_	- (option) password for authentication.
* **path** - _string_	- (option) remote root path. **Default:** '/'
* **autosave** - _boolean_	- (option) To determine whether the automatically uploaded when you open a file directly and modify and save. **Default:** true
* **backup** - _string_	- (option) The local path you want to back up before file saving on the server.
* **privateKey** - _string_	- (option) sftp only. string that contains a private key for either key-based or hostbased user authentication (OpenSSH format) **Default:** none

Example
```json
[
	{
		"name": "my server1",
		"host": "127.0.0.1",
		"port": 21,
		"type": "ftp",
		"username": "id",
		"password": "pw",
		"path" : "/"
	},
	{
		"name": "my server2",
		"host": "127.0.0.1",
		"port": 22,
		"type": "sftp",
		"username": "id",
		"password": "pw",
		"path" : "/",
		"autosave" : false
	},
	{
		"name": "my server3",
		"host": "127.0.0.1",
		"port": 21,
		"type": "sftp",
		"username": "id",
		"password": "pw",
		"path" : "/",
		"backup" : "C:/backup"
	},
	....
]
```