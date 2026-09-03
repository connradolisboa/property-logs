import esbuild from "esbuild";

const buildOptions = {
  entryPoints: {
    main: "main.ts",
    styles: "styles.entry.css",
  },
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  outdir: ".",
  entryNames: "[name]",
  platform: "node",
};

try {
  if (process.argv.includes("--watch")) {
    const context = await esbuild.context(buildOptions);
    await context.watch();
    console.log("Property Logs: watching source files");
  } else {
    await esbuild.build(buildOptions);
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}
