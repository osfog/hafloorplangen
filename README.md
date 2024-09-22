

# hafloorplangen
Small tool for populating floorplans svg documents and generating rules from items fetched from the HA server.

##  Installation

This is a node script so node and npm is needed. 
https://nodejs.org/en/learn/getting-started/how-to-install-nodejs

Install the dependencies for this application
open a terminal in the folder the application is located: and run: npm install


## Running
The application needs to be passed:
	An svg file of the floor plan
	A rules file
	Url to your home assistant server
	A home assistant long lived token to have permission to access the server
	https://www.home-assistant.io/docs/authentication/
	

## Rules
The rules are a very simple construct 

	
### Example
 node genfloorplan.js -s example/planer.svg -r example/rules.yml -u http://www.example.com -t 12345678 
