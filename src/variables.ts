// Single source of truth for doc variables — values that must stay
// attributes, never baked (e.g. per-version product version numbers).
// Bootstrapped from the Antora manifest by migration/converter during the
// migration; MAINTAIN HERE going forward — update the version values on each
// product release (via CI or by hand).
//
// `variablesBySource`: global/unversioned values grouped by ORIGIN — each
// docs repo's own antora.yml, or the shared Antora playbook. Grouping is for
// context/provenance; `variables` is the flat lookup the app consumes.
// `versionedVariables[component][versionName]`: per-version values
// (versionName is 'current' for the current docs version, else the release).
export const variablesBySource: Record<string, Record<string, string>> = {
  // Global Antora playbook (shared across all docs repos; the rest arrive later)
  "playbook": {
    "hazelcast-cloud": "Cloud"
  },
  // hazelcast/cloud-docs — docs/antora.yml
  "cloud": {
    "full-version": "5.6.0",
    "page-cloud-console": "https://cloud.hazelcast.com/",
    "page-cloud-platform-version": "5.6",
    "page-cloud-signup": "https://cloud.hazelcast.com/sign-up"
  },
};

// Flattened lookup consumed by <Variable> (src/components/Variable.tsx) and
// the example-attributes loader. Merged in group order, so a docs-repo value
// overrides a playbook value on the same name.
export const variables: Record<string, string> = Object.assign(
  {},
  ...Object.values(variablesBySource),
);

export const versionedVariables: Record<string, Record<string, Record<string, string>>> = {
  "operator": {
    "current": {
      "operator-chart-version": "5.19.0-snapshot",
      "page-latest-supported-hazelcast": "5.7.0",
      "page-latest-supported-mc": "5.11.0"
    },
    "5.18": {
      "operator-chart-version": "5.18.0",
      "page-latest-supported-hazelcast": "5.7.0",
      "page-latest-supported-mc": "5.11.0"
    },
    "5.17": {
      "operator-chart-version": "5.17.0",
      "page-latest-supported-hazelcast": "5.7.0",
      "page-latest-supported-mc": "5.11.0"
    },
    "5.16": {
      "operator-chart-version": "5.16.0",
      "page-latest-supported-hazelcast": "5.6.0",
      "page-latest-supported-mc": "5.9.0"
    },
    "5.15": {
      "operator-chart-version": "5.15.0",
      "page-latest-supported-hazelcast": "5.5.4",
      "page-latest-supported-mc": "5.7.1"
    },
    "5.14": {
      "operator-chart-version": "5.14.0",
      "page-latest-supported-hazelcast": "5.5.2",
      "page-latest-supported-mc": "5.6.0"
    },
    "5.13": {
      "operator-chart-version": "5.13.0",
      "page-latest-supported-hazelcast": "5.5",
      "page-latest-supported-mc": "5.5"
    },
    "5.12": {
      "operator-chart-version": "5.12.0",
      "page-latest-supported-hazelcast": "5.4.0",
      "page-latest-supported-mc": "5.4.1"
    },
    "5.11": {
      "operator-chart-version": "5.11.0",
      "page-latest-supported-hazelcast": "5.4.0",
      "page-latest-supported-mc": "5.4.0"
    },
    "5.10": {
      "operator-chart-version": "5.10.0",
      "page-latest-supported-hazelcast": "5.3.5",
      "page-latest-supported-mc": "5.3.3"
    },
    "5.9": {
      "operator-chart-version": "5.9.0",
      "page-latest-supported-hazelcast": "5.3.2",
      "page-latest-supported-mc": "5.3.2"
    },
    "5.8": {
      "operator-chart-version": "5.8.0",
      "page-latest-supported-hazelcast": "5.3.1",
      "page-latest-supported-mc": "5.3.1"
    },
    "5.7": {
      "operator-chart-version": "5.7.0",
      "page-latest-supported-hazelcast": "5.2.3",
      "page-latest-supported-mc": "5.2.1"
    },
    "5.6": {
      "operator-chart-version": "5.6.0",
      "page-latest-supported-hazelcast": "5.2.1",
      "page-latest-supported-mc": "5.2.1"
    },
    "5.5": {
      "page-latest-supported-hazelcast": "5.1.4",
      "page-latest-supported-mc": "5.1.4"
    },
    "5.4": {
      "page-latest-supported-hazelcast": "5.1.3",
      "page-latest-supported-mc": "5.1.4"
    },
    "5.3": {
      "page-latest-supported-hazelcast": "5.1.2",
      "page-latest-supported-mc": "5.1.3"
    },
    "5.2": {
      "page-latest-supported-hazelcast": "5.1.1",
      "page-latest-supported-mc": "5.1.1"
    },
    "5.1": {
      "page-latest-supported-hazelcast": "5.0.2",
      "page-latest-supported-mc": "5.0.4"
    },
    "5.0": {
      "page-latest-supported-hazelcast": "5.0.2",
      "page-latest-supported-mc": "5.0.4"
    }
  }
};
