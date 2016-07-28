##Function

- Directly **Open**, **Edit** and **Save** on server files.
- **Save** the **local file** or **directory** to **server**(=upload)
- **Create** a **directory** on the remote server directly.
- **Delete** **directory**(recursive) and **files** directly from the server.

##Available commands
* config - Set the ftp connection information.
* create directory - Create a directory on ftp server.
* open - Open the file directly from ftp server.
* save - File or directory upload to ftp server.(Available from the context menu)
* delete - Delete the file or directory directly from ftp server.

##Startup Settings
1. Press 'F1'  
2. Enter 'ftp-simple' 
3. Pick 'CONFIG' 
4. Enter ftp connection information and save

##Config setting example
See the [easy-ftp](https://www.npmjs.com/package/easy-ftp) details.

* **name** - _string_	- (option) Display name.
* **host** - _string_	- server domain or ip.
* **port** - _number_	- (option) port (default : 21)
* **type** - _string_	- (option) ftp type. 'ftp' or 'sftp' (default : 'ftp')
* **username** - _string_	- username for authentication.
* **password** - _string_	- password for authentication.
* **path** - _string_	- (option) remote root path. **Default:** '/'
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
	}
]
```