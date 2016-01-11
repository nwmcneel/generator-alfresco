'use strict';
var xmldom = require('xmldom');
var domutils = require('./xml-dom-utils.js');

/**
 * This module is in essence a wrapper around the alfresco-module-registry
 * it provides similar methods for adding and removing modules, it uses
 * the registry to figure out if a change is valid and to keep track of a
 * change having occurred. It also interacts with the current project to
 * add/remove files and even update references in poms/context-files, etc.
 */

module.exports = function(yo) {
  var module = {};

  var ops = [];

  module.addModule = function(modOrGroupId, artifactId, ver, packaging, war, loc, path) {
    var mod = yo.moduleRegistry.findModule(modOrGroupId, artifactId, ver, packaging, war, loc, path);
    if (!mod) {
      mod = yo.moduleRegistry.normalizeModule(modOrGroupId, artifactId, ver, packaging, war, loc, path);
    }
    yo.out.info('Adding ' + mod.artifactId + ' module to module registry');
    yo.moduleRegistry.addModule(mod);
    if ('source' === mod.location) {
      //console.log('Scheduling ops for ' + mod.artifactId);
      ops.push(function() { copyTemplateForModule(mod) } );
      ops.push(function() { addModuleToTopPom(mod) } );
      ops.push(function() { addModuleToWarWrapper(mod) } );
      // TODO: what else do we need to do when we remove a module?
    }
  }

  function copyTemplateForModule(mod) {
    var toPath = yo.destinationPath(mod.path);
    if (yo.fs.exists(toPath)) {
      var fromPath = yo.destinationPath('amps_source_templates/' + mod.war + '-' + mod.packaging)
      yo.out.info('TODO: Copying template for ' + mod.artifactId + ' module ' + fromPath + ' to ' + toPath);
      yo.fs.copy(fromPath, toPath);
    } else {
      yo.out.warn('Not copying module as target path already exists: ' + toPath);
    }
  }

  function addModuleToTopPom(mod) {
    // TODO: if intermediate source modules are not included, include them too (amps_source for example.)
    var topPomPath = yo.destinationPath('pom.xml');
    yo.out.info('Adding ' + mod.artifactId + ' module to ' + topPomPath);
    var topPom = yo.fs.read(topPomPath);
    var pom = require('./maven-pom.js')(topPom);
    if (!pom.findModule(mod.artifactId)) {
      pom.addModule(mod.artifactId);
      yo.fs.write(topPomPath, pom.getPOMString());
    }
  }

  function addModuleToWarWrapper(mod) {
    yo.out.info('Adding ' + mod.artifactId + ' module to ' + mod.war + ' war wrapper');
    var wrapperPomPath = yo.destinationPath(mod.war + '/pom.xml');
    var wrapperPom = yo.fs.read(wrapperPomPath);
    var pom = require('./maven-pom.js')(wrapperPom);
    if (!pom.findDependency(mod.groupId, mod.artifactId, mod.version, mod.packaging)) {
      pom.addDependency(mod.groupId, mod.artifactId, mod.version, mod.packaging);
    }

    // search existing plugins for maven-war-plugin, create if necessary
    // once found/created, make sure we have configuation/overlays
    var build = pom.getOrCreateTopLevelElement('pom', 'build');
    var doc = build.ownerDocument;
    var plugins = domutils.getOrCreateChild(doc, build, 'pom', 'plugins');
    var plugin = domutils.getOrCreateChild(doc, plugins, 'pom', 'plugin');
    var artifactIdText = '';
    do {
      var artifactId = domutils.getOrCreateChild(doc, plugin, 'pom', 'artifactId');
      artifactIdText = artifactId.textContent;
      if (artifactIdText) {
        if ('maven-war-plugin' !== artifactIdText) {
          plugin = domutils.getNextElementSibling(plugin);
          // exhausted existing plugins, so we need to add one
          if (undefined === plugin) {
            plugin = domutils.createChild(doc, plugins, 'pom', 'plugin');
          }
        }
      } else {
        artifactIdText = 'maven-war-plugin';
        artifactId.textContent = artifactIdText;
      }
    } while ('maven-war-plugin' !== artifactIdText)
    var configuration = domutils.getOrCreateChild(doc, plugin, 'pom', 'configuration');
    var overlays = domutils.getOrCreateChild(doc, configuration, 'pom', 'overlays');
    var overlay = pom.addOverlay(mod.groupId, mod.artifactId, mod.packaging);
    //console.log(pom.getPOMString());
    yo.fs.write(wrapperPomPath, pom.getPOMString());
  }

  module.removeModule = function(modOrGroupId, artifactId, ver, packaging, war, loc, path) {
    //console.log("SEARCHING FOR MODULE: " + modOrGroupId.artifactId);
    var mod = yo.moduleRegistry.findModule(modOrGroupId, artifactId, ver, packaging, war, loc, path);
    if (mod) {
      //console.log("REMOVING MODULE: " + mod.artifactId);
      yo.moduleRegistry.removeModule(mod);
      if ('source' === mod.location) {
        ops.push(function() { removeModuleFiles(mod) } );
        ops.push(function() { removeModuleFromTopPom(mod) } );
        ops.push(function() { removeModuleFromWarWrapper(mod) } );
        // TODO: what else do we need to do when we remove a module?
      }
    }
  }

  function removeModuleFiles(mod) {
    // remove the actual files
    yo.out.warn('Deleting source module: ' + mod.path);
    var absPath = yo.destinationPath(mod.path);
    // if we have files on disk already this will get them
    //console.log("DELETING EXISTING FILES FROM: " + absPath);
    yo.fs.delete(absPath);
    // if we have files in mem-fs, this should get those
    yo.fs.store.each(function(file, idx) {
      if (file.path.indexOf(absPath) == 0) {
        //console.log("DELETING: " + file.path);
        yo.fs.delete(file.path);
      }
    });
  }

  function removeModuleFromTopPom(mod) {
    var topPomPath = yo.destinationPath('pom.xml');
    yo.out.warn('Removing ' + mod.artifactId + ' module from ' + topPomPath);
    var topPom = yo.fs.read(topPomPath);
    var pom = require('./maven-pom.js')(topPom);
    if (pom.findModule(mod.artifactId)) {
      pom.removeModule(mod.artifactId);
      yo.fs.write(topPomPath, pom.getPOMString());
    }
  }

  function removeModuleFromWarWrapper(mod) {
    // TODO: remove dependency and overlay from repo / share war wrapper modules
    yo.out.warn('Removing ' + mod.artifactId + ' module from ' + mod.war + ' war wrapper');
  }

  module.save = function() {
    //console.log('Saving module registry and performing scheduled tasks');
    yo.moduleRegistry.save();
    ops.forEach(function(op) {
      op.call(this);
    });
    ops = [];
  }

  return module;
};

// vim: autoindent expandtab tabstop=2 shiftwidth=2 softtabstop=2