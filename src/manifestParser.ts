/*---------------------------------------------------------
 * ManifestParser
 *
 * Finds and parses Elixir compiler manifests - the files
 * that associate beam files with source files. This is used
 * by the debugger to debug modules.
 *
 * Copyright James Norton 2016.
 *--------------------------------------------------------*/

import {readFileSync, readdirSync, lstatSync} from 'fs';
import {basename, dirname, sep} from 'path';
//var glob = require('glob');
//var FindFiles = require('node-find-files');
var Finder = require('fs-finder');

export default class ManifestParser {
	// Returns a path to a beam file and a source file
	public static parseManifest(file: string): Array<Array<string>> {

		var rval: Array<Array<string>> = [];

		var manifest = readFileSync(file, "UTF-8");

		for (var m of manifest.match(/{(.|\n)*?}/g)) {
			var entries = m.split(",");
			var type = entries[2];
			if (type != 'module'){
				continue;
			}
			var beamFile = entries[0].match(/<<"(.*?)">>/)[1];
			var module = entries[1].match(/'(.*?)'/)[1];
			var src = entries[3].match(/<<"(.*?)">>/)[1];

			rval.push([beamFile, module, src]);
		}

		return rval;

	}

	public static find(dir: string, fileName: string): Array<string> {
		var rval: Array<string> = [];

		for (var file of readdirSync(dir)) {
			var path = dir + sep + file;

			if(file == fileName) {
				rval.push(path);
			}

			if(lstatSync(path).isDirectory()){
				rval = rval.concat(ManifestParser.find(path, fileName));
			}
		}

		return rval;
	}

	public static parseManifests(dir: string): Array<Array<string>> {
		var rval: Array<Array<string>> = [];

		var files = ManifestParser.find(dir, '.compile.elixir');

		for (var file of files){
			var manifests = ManifestParser.parseManifest(file);
			rval = rval.concat(manifests);
		}

		return rval;
	}


}
