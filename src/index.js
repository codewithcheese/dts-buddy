import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import MagicString from 'magic-string';
import { getLocator } from 'locate-character';
import { SourceMapGenerator } from '@jridgewell/source-map';
import { get_input_files, is_declaration, resolve_dts, walk, write } from './utils.js';
import { create_module_declaration } from './create-module-declaration.js';

/**
 * @param {{
 *   output: string;
 *   modules: Record<string, string>;
 *   project?: string;
 *   compilerOptions?: ts.CompilerOptions;
 *   include?: string[];
 *   exclude?: string[];
 *   debug?: string;
 * }} options
 * @returns {Promise<void>}
 */
export async function createBundle(options) {
	const project = options.project ?? 'tsconfig.json';
	const output = path.resolve(options.output);
	const debug = options.debug && path.resolve(options.debug);

	/** @type {Record<string, string>} */
	const modules = {};
	for (const id in options.modules) {
		modules[id] = path.resolve(options.modules[id]).replace(/(\.d\.ts|\.js|\.ts)$/, '.d.ts');
	}

	const cwd = path.resolve(path.dirname(project));
	const tsconfig = eval(`(${fs.readFileSync(project, 'utf-8')})`);

	const input = get_input_files(
		cwd,
		options.include ?? tsconfig.include,
		options.exclude ?? tsconfig.exclude
	);

	const original_cwd = process.cwd();
	process.chdir(cwd);

	try {
		/** @type {ts.CompilerOptions} */
		const compilerOptions = {
			...tsconfig.compilerOptions,
			...options.compilerOptions,
			allowJs: true,
			checkJs: true,
			declaration: true,
			declarationDir: undefined,
			declarationMap: true,
			emitDeclarationOnly: true,
			moduleResolution: undefined,
			noEmit: false,
			noEmitOnError: false,
			outDir: undefined
		};

		/** @type {Record<string, string>} */
		const created = {};
		const host = ts.createCompilerHost(compilerOptions);
		host.writeFile = (file, contents) => (created[file.replace(/\//g, path.sep)] = contents);

		const program = ts.createProgram(input, compilerOptions, host);
		program.emit();

		console.log(Object.keys(created));

		if (debug) {
			for (const file in created) {
				const relative = path.relative(cwd, file);
				const dest = path.join(debug, relative);
				write(dest, created[file]);
			}

			for (const file of input) {
				if (!file.endsWith('.d.ts')) continue;
				const relative = path.relative(cwd, file);
				const dest = path.join(debug, relative);
				write(dest, fs.readFileSync(file, 'utf-8'));
			}
		}

		let types = '';

		/** @type {Map<string, string[]>} **/
		const all_exports = new Map();

		/** @type {Map<string, Map<string, import('./types').Mapping>>} */
		const all_mappings = new Map();

		/** @type {Set<string>} */
		const ambient_modules = new Set();

		let first = true;

		/**
		 * @param {string} file
		 * @param {string} specifier
		 * @returns {string | null}
		 */
		function resolve(file, specifier) {
			// if a module imports from another module we're declaring,
			// leave the import intact
			if (specifier in modules) {
				return null;
			}

			// resolve relative imports and aliases (from tsconfig.paths)
			return specifier.startsWith('.')
				? resolve_dts(path.dirname(file), specifier)
				: compilerOptions.paths && specifier in compilerOptions.paths
				? resolve_dts(cwd, compilerOptions.paths[specifier][0])
				: null;
		}

		for (const id in modules) {
			if (!first) types += '\n\n';
			first = false;

			const { content, mappings, ambient } = create_module_declaration(
				id,
				modules[id],
				created,
				resolve
			);

			types += content;
			all_mappings.set(id, mappings);
			for (const id of ambient) {
				ambient_modules.add(id);
			}
		}

		for (const file of ambient_modules) {
			// clean up ambient module then inject wholesale
			// TODO do we need sourcemaps here?
			const dts = created[file] ?? fs.readFileSync(file, 'utf8');
			const result = new MagicString(dts);

			const index = dts.indexOf('//# sourceMappingURL=');
			if (index !== -1) result.remove(index, dts.length);

			const ast = ts.createSourceFile(file, dts, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);

			ts.forEachChild(ast, (node) => {
				if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
					walk(node, (node) => {
						// @ts-expect-error
						if (node.jsDoc) {
							// @ts-expect-error
							for (const jsDoc of node.jsDoc) {
								if (jsDoc.comment) {
									// @ts-expect-error
									jsDoc.tags?.forEach((tag) => {
										result.remove(tag.pos, tag.end);
									});
								} else {
									result.remove(jsDoc.pos, jsDoc.end);
								}
							}
						}
					});
				}
			});

			types += result.trim().toString();
		}

		// finally, add back exports as appropriate
		const ast = ts.createSourceFile(output, types, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
		const magic_string = new MagicString(types);
		const locator = getLocator(types, { offsetLine: 1 });
		const smg = new SourceMapGenerator({ file: path.basename(output) });

		/** @type {Set<string>} */
		const sources = new Set();

		ts.forEachChild(ast, (node) => {
			if (ts.isModuleDeclaration(node)) {
				if (!node.body) return;

				const name = node.name.text;

				const mappings = all_mappings.get(name);

				node.body.forEachChild((node) => {
					if (is_declaration(node)) {
						const identifier = ts.isVariableStatement(node)
							? ts.getNameOfDeclaration(node.declarationList.declarations[0])
							: ts.getNameOfDeclaration(node);

						if (identifier) {
							const name = identifier.getText(ast);

							const mapping = mappings?.get(name);

							if (mapping) {
								const start = identifier.getStart(ast);
								let { line, column } = locator(start);

								const relative = path.relative(path.dirname(output), mapping.source);

								smg.addMapping({
									generated: { line, column },
									original: { line: mapping.line, column: mapping.column },
									source: relative,
									name
								});

								smg.addMapping({
									generated: { line, column: column + name.length },
									original: { line: mapping.line, column: mapping.column + name.length },
									source: relative,
									name
								});

								sources.add(mapping.source);
							}
						}
					}
				});
			}
		});

		// for (const source of sources) {
		// 	smg.setSourceContent(
		// 		path.relative(path.dirname(output), source),
		// 		fs.readFileSync(source, 'utf8')
		// 	);
		// }

		const comment = `//# sourceMappingURL=${path.basename(output)}.map`;
		magic_string.append(`\n\n${comment}`);

		write(output, magic_string.toString());

		write(`${output}.map`, JSON.stringify(smg.toJSON(), null, '\t'));
	} finally {
		process.chdir(original_cwd);
	}
}
