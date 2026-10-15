module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name !== "better-auth" || pkg.version !== "1.7.2") return pkg;
      // The server uses the Drizzle adapter, not Better Auth's schema CLI or
      // test helpers. Optional build-tool peers otherwise enter its production
      // graph from workspace dev dependencies, including obsolete Go binaries.
      // Remove both fields: leaving optional metadata recreates a wildcard peer.
      for (const name of ["drizzle-kit", "vitest"]) {
        if (!(name in (pkg.peerDependencies ?? {})) && !(name in (pkg.peerDependenciesMeta ?? {}))) continue;
        if (pkg.peerDependenciesMeta?.[name]?.optional !== true) {
          throw new Error("Better Auth optional build-tool peer contract changed");
        }
        delete pkg.peerDependencies[name];
        delete pkg.peerDependenciesMeta[name];
      }
      return pkg;
    },
  },
};
