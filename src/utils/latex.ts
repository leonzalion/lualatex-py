import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';
import type { ExecaChildProcess } from 'execa';
import { execa } from 'execa';
import filenamify from 'filenamify';

export class LatexError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'LatexError';
	}
}

export async function runLatex(latexCb: () => ExecaChildProcess) {
	try {
		const latexProcess = latexCb();
		await latexProcess;
	} catch (error: unknown) {
		throw new LatexError((error as Error).message);
	}
}

async function luaLatex({ latexFilePath }: { latexFilePath: string }) {
	await runLatex(() =>
		execa(
			'lualatex',
			[
				'--shell-escape',
				'--enable-write18',
				'-synctex=1',
				'-interaction=nonstopmode',
				'-file-line-error',
				latexFilePath,
			],
			{ stdio: 'inherit' }
		)
	);
}

type CompileLatexProps = {
	latexFilePath: string;
	outputDirectory: string;
	ignoreDirectories?: string[];
};
export async function compileLatex({
	latexFilePath,
	outputDirectory: outputDirectoryProp,
	ignoreDirectories = [],
}: CompileLatexProps) {
	const oldCwd = process.cwd();

	const workingDir = path.dirname(latexFilePath);
	const outputDirectory = path.resolve(workingDir, outputDirectoryProp);

	const filename = path.basename(latexFilePath, '.tex');
	const filenameWithExt = path.basename(latexFilePath);
	const tempLatexWorkflowDir = path.join(workingDir, '../.latex-workflow');
	const tempDir = path.resolve(tempLatexWorkflowDir, filenamify(filename));

	try {
		await fs.promises.rm(tempDir, { force: true, recursive: true });
		await fs.promises.mkdir(tempDir, { recursive: true });

		const execaOptions = { stdio: 'inherit' } as const;

		const workingDirEntries = await fs.promises.readdir(workingDir);
		const workingDirEntriesToSymlink = workingDirEntries
			.filter(
				(entryName) =>
					!ignoreDirectories.includes(entryName) &&
					// Don't symlink .tex files (in case they are changed during the build)
					path.parse(entryName).ext !== '.tex' &&
					// Don't copy output directory
					entryName !== path.basename(outputDirectory)
			)
			.map((entryName) => path.join(workingDir, entryName));

		const workingDirEntriesToCopy = workingDirEntries
			.filter(
				(entryName) =>
					!ignoreDirectories.includes(entryName) &&
					// Copy .tex files (in case they are changed during the build)
					path.parse(entryName).ext === '.tex'
			)
			.map((entryName) => path.join(workingDir, entryName));

		// Symlink all the files into the output directory
		// The symlinked folder is created in the same directory level as the LaTeX files
		if (workingDirEntriesToSymlink.length > 0) {
			await execa('ln', ['-s', ...workingDirEntriesToSymlink, tempDir]);
		}

		if (workingDirEntriesToCopy.length > 0) {
			// Copy all .tex files to output directory
			await execa('cp', [...workingDirEntriesToCopy, tempDir]);
		}

		// Change directory into the temporary artifacts directory
		process.chdir(tempDir);

		// Clean the old artifacts generated by pythontex
		await fs.promises.rm(`pythontex-files-${filename}`, {
			force: true,
			recursive: true,
		});
		await fs.promises.rm(`${filename}.pytxcode`, { force: true });

		await luaLatex({ latexFilePath });

		// If there's pythontex artifacts outputted, run `pythontex`
		if (fs.existsSync(`${tempDir}/${filename}.pytxcode`)) {
			await runLatex(() => execa('pythontex', [filenameWithExt], execaOptions));
			await luaLatex({ latexFilePath });
		}

		// Run biber
		if (fs.existsSync(`${tempDir}/${filename}.bcf`)) {
			await runLatex(() => execa('biber', [filename]));
			await luaLatex({ latexFilePath });
		}

		await fs.promises.mkdir(outputDirectory, { recursive: true });
		const tempEntries = await fs.promises.readdir(tempDir);
		const entriesToCopy = tempEntries.filter((entryName) => {
			// .tex files don't belong in the output directory
			if (path.parse(entryName).ext === '.tex') return false;

			return true;
		});

		// Clean the output directory
		await fs.promises.rm(outputDirectory, { recursive: true, force: true });

		// Copy all the temp files into the output directory
		await Promise.all(
			entriesToCopy.map(async (tempFile) => {
				const tempFileLstat = await fs.promises.lstat(tempFile);
				if (tempFileLstat.isSymbolicLink()) return;
				await fs.promises.cp(tempFile, path.join(outputDirectory, tempFile), {
					recursive: true,
				});
			})
		);

		// Attempt to remove the parent directory (only works when empty)
		try {
			await fs.promises.rm(tempLatexWorkflowDir);
		} catch {}
	} catch (error: unknown) {
		// On failure, copy all the temp files to the output directory so it's debuggable
		const tempDirEntries = await fs.promises.readdir(tempDir);
		const entriesToCopy = tempDirEntries.filter((entryName) => {
			// .tex files don't belong in the output directory
			if (path.parse(entryName).ext === '.tex') return false;

			return true;
		});

		// Copy all the temp files into the output directory
		await Promise.all(
			entriesToCopy.map(async (tempFile) => {
				const tempFileLstat = await fs.promises.lstat(tempFile);
				if (tempFileLstat.isSymbolicLink()) return;
				await fs.promises.cp(tempFile, path.join(outputDirectory, tempFile), {
					recursive: true,
				});
			})
		);

		throw error;
	} finally {
		process.chdir(oldCwd);
	}
}
