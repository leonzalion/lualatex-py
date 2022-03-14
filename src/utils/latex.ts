import path from 'node:path';
import fs from 'node:fs';
import type { ExecaChildProcess } from 'execa';
import { execa } from 'execa';
import { dir } from 'tmp-promise';
import { compileJsLatex } from 'jslatex';

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

async function luaLatex({
	latexFilePath,
	tempDir,
}: {
	latexFilePath: string;
	tempDir: string;
}) {
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
			{ stdio: 'inherit', cwd: tempDir }
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
	const workingDir = path.dirname(latexFilePath);
	const outputDirectory = path.resolve(workingDir, outputDirectoryProp);

	const filename = path.basename(latexFilePath, '.tex');
	const filenameWithExt = path.basename(latexFilePath);
	const { path: tempDir, cleanup } = await dir({ unsafeCleanup: true });

	async function copyTempFilesToOutdir({ force }: { force: boolean }) {
		const tempEntries = await fs.promises.readdir(tempDir);

		const entriesToCopy = tempEntries.filter((entryName) => {
			// .tex files don't belong in the output directory
			const { ext } = path.parse(entryName);
			if (ext === '.tex' || ext === '.jtex') return false;

			return true;
		});

		// Copy all the temp files into the output directory
		await Promise.all(
			entriesToCopy.map(async (tempFile) => {
				const tempFilePath = path.join(tempDir, tempFile);
				const tempFileLstat = await fs.promises.lstat(tempFilePath);
				if (tempFileLstat.isSymbolicLink()) return;
				await fs.promises.cp(
					tempFilePath,
					path.join(outputDirectory, tempFile),
					{
						recursive: true,
						force,
					}
				);
			})
		);
	}

	try {
		const execaOptions = { cwd: tempDir, stdio: 'inherit' } as const;
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

		// Clean the old artifacts generated by pythontex
		await fs.promises.rm(`pythontex-files-${filename}`, {
			force: true,
			recursive: true,
		});
		await fs.promises.rm(`${filename}.pytxcode`, { force: true });

		// If the file uses JSLaTeX, compile and write the corresponding .tex file
		const latex = await fs.promises.readFile(latexFilePath, 'utf-8');
		const jsLatex = await compileJsLatex({ latex });
		latexFilePath = `${path.parse(latexFilePath).name}.tex`;
		await fs.promises.writeFile(latexFilePath, jsLatex);

		await luaLatex({ latexFilePath, tempDir });

		// If there's pythontex artifacts outputted, run `pythontex`
		if (fs.existsSync(`${tempDir}/${filename}.pytxcode`)) {
			await runLatex(() => execa('pythontex', [filenameWithExt], execaOptions));
			await luaLatex({ latexFilePath, tempDir });
		}

		// Run biber
		if (fs.existsSync(`${tempDir}/${filename}.bcf`)) {
			await runLatex(() => execa('biber', [filename], execaOptions));
			await luaLatex({ latexFilePath, tempDir });
		}

		await fs.promises.mkdir(outputDirectory, { recursive: true });
		await copyTempFilesToOutdir({ force: true });
	} catch (error: unknown) {
		await copyTempFilesToOutdir({ force: false });
		throw error;
	} finally {
		await cleanup();
	}
}
