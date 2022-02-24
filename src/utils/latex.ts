import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';
import type { ExecaError } from 'execa';
import { execaSync } from 'execa';
import filenamify from 'filenamify';

type CompileLatexProps = {
	latexFilePath: string;
	outputDirectory: string;
	ignoreDirectories?: string[];
};
export function compileLatex({
	latexFilePath,
	outputDirectory: outputDirectoryProp,
	ignoreDirectories = [],
}: CompileLatexProps) {
	const oldCwd = process.cwd();

	try {
		const workingDir = path.dirname(latexFilePath);
		const outputDirectory = path.resolve(workingDir, outputDirectoryProp);

		const filename = path.basename(latexFilePath, '.tex');
		const filenameWithExt = path.basename(latexFilePath);
		const tempLatexWorkflowDir = path.join(workingDir, '../.latex-workflow');
		const tempDir = path.resolve(tempLatexWorkflowDir, filenamify(filename));
		fs.rmSync(tempDir, { force: true, recursive: true });
		fs.mkdirSync(tempDir, { recursive: true });

		const execaOptions = { stdio: 'inherit' } as const;

		const workingDirEntries = fs
			.readdirSync(workingDir)
			// Don't copy output directory
			.filter(
				(entryName) =>
					!ignoreDirectories.includes(entryName) &&
					entryName !== path.basename(outputDirectory)
			)
			.map((entryName) => path.join(workingDir, entryName));

		// Symlink all the files into the output directory
		// The symlinked folder is created in the same directory level as the LaTeX files
		execaSync('ln', ['-s', ...workingDirEntries, tempDir]);

		// Change directory into the temporary artifacts directory
		process.chdir(tempDir);

		// Clean the old artifacts generated by pythontex
		fs.rmSync(`pythontex-files-${filename}`, { force: true, recursive: true });
		fs.rmSync(`${filename}.pytxcode`, { force: true });

		execaSync(
			'lualatex',
			[
				'--shell-escape',
				'--enable-write18',
				'-synctex=1',
				'-interaction=nonstopmode',
				'-file-line-error',
				filenameWithExt,
			],
			execaOptions
		);

		let wasPythonTexRun = false;
		// If there's pythontex artifacts outputted, run `pythontex`
		if (fs.existsSync(`${tempDir}/${filename}.pytxcode`)) {
			execaSync('pythontex', [filenameWithExt], execaOptions);
			wasPythonTexRun = true;
		}

		let wasBibTextRun = false;
		// Run bibtex
		if (fs.existsSync(`${tempDir}/${filename}.bcf`)) {
			try {
				execaSync('bibtex', [filename]);
			} catch (error: unknown) {
				const { exitCode } = error as ExecaError;
				if (exitCode !== 2) {
					throw error;
				}
			}

			wasBibTextRun = true;
		}

		if (wasPythonTexRun || wasBibTextRun) {
			execaSync(
				'lualatex',
				[
					'--shell-escape',
					'--enable-write18',
					'-synctex=1',
					'-interaction=nonstopmode',
					'-file-line-error',
					latexFilePath,
				],
				execaOptions
			);
		}

		fs.mkdirSync(outputDirectory, { recursive: true });
		const entriesToCopy = fs.readdirSync(tempDir).filter((entryName) => {
			// .tex files don't belong in the output directory
			if (path.parse(entryName).ext === '.tex') return false;

			return true;
		});
		// Copy all the temp files into the output directory
		for (const tempFile of entriesToCopy) {
			fs.cpSync(tempFile, path.join(outputDirectory, tempFile), {
				recursive: true,
			});
		}

		// Fs.rmSync(tempDir, { recursive: true, force: true });
		// Attempt to remove the parent directory (only works when empty)
		try {
			fs.rmSync(tempLatexWorkflowDir);
		} catch {}
	} finally {
		process.chdir(oldCwd);
	}
}
