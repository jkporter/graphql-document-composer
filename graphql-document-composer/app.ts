#!/usr/bin/env node
import { extendSchema, buildASTSchema, printSchema } from 'graphql/utilities'
import { parse, Source, isTypeSystemDefinitionNode, isTypeSystemExtensionNode, DirectiveDefinitionNode, TypeDefinitionNode, TypeExtensionNode, DocumentNode, isTypeDefinitionNode, TypeNode, NamedTypeNode } from 'graphql/language';
import { GraphQLSchema } from 'graphql/type';
import { DepGraph } from 'dependency-graph';
import * as fs from 'fs';
import * as path from 'path';
import * as program from 'commander';

function directoryWalker(directory, done) {
    let results = [];

    fs.readdir(directory, function (err, list) {
        if (err) return done(err);

        let pending = list.length;

        if (!pending) return done(null, results);

        list.forEach(function (file) {
            file = path.resolve(directory, file);

            fs.stat(file, function (err, stat) {
                // If directory, execute a recursive call
                if (stat && stat.isDirectory()) {
                    // Add directory to array [comment if you need to remove the directories from the array]
                    results.push(file);

                    directoryWalker(file, function (err, res) {
                        results = results.concat(res);
                        if (!--pending) done(null, results);
                    });
                } else {
                    results.push(file);

                    if (!--pending) done(null, results);
                }
            });
        });
    });
}

function unwrap(typeNode: TypeNode): NamedTypeNode {
    return typeNode.kind === 'NamedType' ? typeNode : unwrap(typeNode.type);
}

function hasExtentionsFor(documentA: DocumentNode, documentB: DocumentNode): boolean {
    for (const typeSystemExtensionNode of documentA.definitions.filter(isTypeSystemExtensionNode)) {
        for (const typeSystemDefinitionNode of documentB.definitions.filter(isTypeSystemDefinitionNode)) {
            const typeDefinitionMatch = /^(.+)Definition$/.exec(typeSystemDefinitionNode.kind);
            const typeExtensionMatch = /^(.+)Extension$/.exec(typeSystemExtensionNode.kind);

            if (typeDefinitionMatch[1] === 'Schema' && typeExtensionMatch[1] === 'Schema')
                return true;

            if (typeDefinitionMatch[1] === typeExtensionMatch[1]
                && ((typeSystemDefinitionNode as TypeDefinitionNode | DirectiveDefinitionNode).name.value === (typeSystemExtensionNode as TypeExtensionNode).name.value))
                return true;
        }
    }
    return false;
}

function hasTypesFor(documentA: DocumentNode, documentB: DocumentNode) {
    const typeNames: string[] = [];
    const directiveNames: string[] = [];

    for (const definition of documentA.definitions) {
        if (isTypeDefinitionNode(definition))
            directiveNames.push(...definition.directives.map(directive => directive.name.value))

        if (definition.kind === 'ObjectTypeDefinition' || definition.kind === 'ObjectTypeExtension')
            typeNames.push(...definition.interfaces.map(graphQLinterface => graphQLinterface.name.value));

        if (definition.kind === 'ObjectTypeDefinition'
            || definition.kind === 'InterfaceTypeDefinition'
            || definition.kind === 'InputObjectTypeDefinition'
            || definition.kind === 'ObjectTypeExtension'
            || definition.kind === 'InterfaceTypeExtension'
            || definition.kind === 'InputObjectTypeExtension')
            for (const field of definition.fields) {
                if (field.kind === 'FieldDefinition')
                    typeNames.push(...field.arguments.map(argument => unwrap(argument.type).name.value));
                typeNames.push(unwrap(field.type).name.value);
                directiveNames.push(...field.directives.map(directive => directive.name.value))
            }

        if (definition.kind === 'UnionTypeDefinition' || definition.kind === 'UnionTypeExtension')
            typeNames.push(...definition.types.map(type => unwrap(type).name.value));

        if (definition.kind === 'EnumTypeDefinition' || definition.kind === 'EnumTypeExtension')
            directiveNames.push(...definition.values.reduce((names, value) => names.concat(value.directives.map(directive => directive.name.value)), []));
    }

    if (documentB.definitions
        .filter(definition => definition.kind === 'DirectiveDefinition')
        .some(directive => directiveNames.findIndex(name => name === (directive as DirectiveDefinitionNode).name.value) > -1))
        return true;

    if (documentB.definitions
        .filter(isTypeDefinitionNode)
        .some(type => typeNames.findIndex(name => name === type.name.value) > -1))
        return true;

    return false;
}

function isDependentOn(documentA: DocumentNode, documentB: DocumentNode) {
    return hasExtentionsFor(documentA, documentB) || hasTypesFor(documentA, documentB)
}

function build(dir: string, output: string) {
    directoryWalker(dir, function (err, data) {
        if (err)
            throw err;

        const sources = data.filter(fileName => fileName.toLowerCase().endsWith(".graphql")).map((fileName, index) => {
            const body = fs.readFileSync(fileName, 'utf8');
            return new Source(body, path.relative(dir, fileName));
        });

        const graph = new DepGraph();
        const documents = sources.map(source => parse(source));
        documents.forEach(document => {
            console.log(`Adding ${document.loc.source.name}`);
            graph.addNode(document.loc.source.name, document);
        });

        documents.forEach(documentA => {
            documents.forEach(documentB => {
                if (documentA.loc.source.name !== documentB.loc.source.name && isDependentOn(documentA, documentB)) {
                    console.log(`"${documentA.loc.source.name}" has a dependencey with "${documentB.loc.source.name}".`);
                    graph.addDependency(documentA.loc.source.name, documentB.loc.source.name);
                }
            });
        });

        const schema = graph.overallOrder()
            .map(nodeName => graph.getNodeData(nodeName))
            .reduce<GraphQLSchema>(
                (schema, document: DocumentNode, index) => {
                    if (index === 0)
                        console.log(`Budiling schema with ${document.loc.source.name}.`);
                    else
                        console.log(`Extending with ${document.loc.source.name}.`);
                    return index == 0 ? buildASTSchema(document) : extendSchema(schema, document)
                },
                null);

        fs.writeFileSync(output, printSchema(schema));
    });
}

program
    .version('0.0.0', '-v, --version')
    .option('-s, --source <sourceDirectory>', 'Source directory.')
    .option('-o, --output <outputFilename>', 'Output filename.')
    .option('-w, --watch', 'Watch for changes and re-build.')
    .parse(process.argv);

if (program.watch) {
    fs.watch(program.source, { recursive: true }, (eventType, filename) => {
        if (filename.toLowerCase().endsWith(".graphql"))
            return;
        build(program.source, program.output);
    });
}

build(program.source, program.output);