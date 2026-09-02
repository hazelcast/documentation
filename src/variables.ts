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
    "full-version": "5.7.1",
    "page-cloud-console": "https://cloud.hazelcast.com/",
    "page-cloud-platform-version": "5.7",
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
  "clc": {
    "current": {
      "full-version": "5.5.1",
      "hazelcast-cloud": "Cloud",
      "page-latest-supported-mc": "5.8"
    },
    "5.5.0": {
      "full-version": "5.5.0",
      "hazelcast-cloud": "Cloud",
      "page-latest-supported-mc": "5.6"
    },
    "5.4.1": {
      "full-version": "5.4.1",
      "hazelcast-cloud": "Cloud",
      "page-latest-supported-mc": "5.5"
    },
    "5.4.0": {
      "full-version": "5.4.0",
      "hazelcast-cloud": "Cloud",
      "page-latest-supported-mc": "5.4"
    },
    "5.3.7": {
      "full-version": "5.3.7",
      "hazelcast-cloud": "Cloud",
      "page-latest-supported-mc": "5.5"
    },
    "5.3.6": {
      "full-version": "5.3.6",
      "hazelcast-cloud": "Cloud",
      "page-latest-supported-mc": "5.5"
    },
    "5.3.5": {
      "full-version": "5.3.5",
      "hazelcast-cloud": "Cloud",
      "page-latest-supported-mc": "5.5"
    },
    "5.3.4": {
      "full-version": "5.3.4",
      "hazelcast-cloud": "Cloud",
      "page-latest-supported-mc": "5.5"
    },
    "5.2.1": {
      "full-version": "5.2.1",
      "hazelcast-cloud": "Cloud"
    }
  },
  "hazelcast": {
    "6.0-snapshot": {
      "ee-version": "6.0.0-SNAPSHOT",
      "enterprise-product-name": "Enterprise Edition",
      "full-version": "6.0.0-SNAPSHOT",
      "hazelcast-cloud": "Cloud",
      "hz-repo-swagger-branch": "master",
      "java-client": "Java Client and Embedded Server",
      "jet-version": "4.5.4",
      "minimum-java-version": "17",
      "minimum-maven-version": "3.9",
      "minor-version": "6.0-SNAPSHOT",
      "open-source-product-name": "Community Edition",
      "os-version": "6.0.0-SNAPSHOT",
      "page-latest-supported-clc": "5.5.1",
      "page-latest-supported-cplusplus-client": "5.7.0",
      "page-latest-supported-csharp-client": "5.7.0",
      "page-latest-supported-go-client": "1.6.0",
      "page-latest-supported-mc": "5.12-snapshot",
      "page-latest-supported-mc-installer": "latest-snapshot",
      "page-latest-supported-nodejs-client": "5.7.0",
      "page-latest-supported-po": "latest-snapshot",
      "page-latest-supported-python-client": "5.7.0",
      "ucd": "User Code Deployment",
      "ucn": "User Code Namespaces",
      "url-cloud-signup": "https://cloud.hazelcast.com/sign-up?utm_source=docs-website",
      "version": "6.0-SNAPSHOT"
    },
    "5.7": {
      "ee-version": "5.7.1",
      "enterprise-product-name": "Enterprise Edition",
      "full-version": "5.7.1",
      "hazelcast-cloud": "Cloud",
      "hz-repo-swagger-branch": "master",
      "java-client": "Java Client and Embedded Server",
      "jet-version": "4.5.4",
      "minimum-java-version": "17",
      "minimum-maven-version": "3.9",
      "minor-version": "5.7",
      "open-source-product-name": "Community Edition",
      "os-version": "5.7.0",
      "page-latest-supported-clc": "5.5.1",
      "page-latest-supported-cplusplus-client": "5.7.0",
      "page-latest-supported-csharp-client": "5.6.0",
      "page-latest-supported-go-client": "1.5.0",
      "page-latest-supported-mc": "5.11",
      "page-latest-supported-mc-installer": "latest-snapshot",
      "page-latest-supported-nodejs-client": "5.6.0",
      "page-latest-supported-po": "latest-snapshot",
      "page-latest-supported-python-client": "5.6.0",
      "ucd": "User Code Deployment",
      "ucn": "User Code Namespaces",
      "url-cloud-signup": "https://cloud.hazelcast.com/sign-up?utm_source=docs-website",
      "version": "5.7"
    },
    "5.6": {
      "ee-version": "5.6.1",
      "enterprise-product-name": "Enterprise Edition",
      "full-version": "5.6.1",
      "hazelcast-cloud": "Cloud",
      "hz-repo-swagger-branch": "5.6.z",
      "java-client": "Java Client and Embedded Server",
      "jet-version": "4.5.4",
      "minimum-java-version": "17",
      "minimum-maven-version": "3.9",
      "minor-version": "5.6",
      "open-source-product-name": "Community Edition",
      "os-version": "5.6.0",
      "page-latest-supported-clc": "5.5.0",
      "page-latest-supported-cplusplus-client": "5.4.0",
      "page-latest-supported-csharp-client": "5.5.0",
      "page-latest-supported-go-client": "1.4.2",
      "page-latest-supported-mc": "5.9",
      "page-latest-supported-mc-installer": "latest-snapshot",
      "page-latest-supported-nodejs-client": "5.3.0",
      "page-latest-supported-po": "5.16",
      "page-latest-supported-python-client": "5.6.0",
      "ucd": "User Code Deployment",
      "ucn": "User Code Namespaces",
      "url-cloud-signup": "https://cloud.hazelcast.com/sign-up?utm_source=docs-website",
      "version": "5.6"
    },
    "5.5": {
      "ee-version": "5.5.10",
      "enterprise-product-name": "Enterprise Edition",
      "full-version": "5.5.10",
      "hazelcast-cloud": "Cloud",
      "hz-repo-swagger-branch": "5.5.z",
      "java-client": "Java Client and Embedded Server",
      "jet-version": "4.5.4",
      "minimum-java-version": "17",
      "minor-version": "5.5",
      "open-source-product-name": "Community Edition",
      "os-version": "5.5.0",
      "page-latest-supported-clc": "5.5.0",
      "page-latest-supported-cplusplus-client": "5.3.1",
      "page-latest-supported-csharp-client": "5.4.0",
      "page-latest-supported-go-client": "1.4.2",
      "page-latest-supported-mc": "5.9",
      "page-latest-supported-nodejs-client": "5.3.0",
      "page-latest-supported-po": "5.16",
      "page-latest-supported-python-client": "5.6.0",
      "ucd": "User Code Deployment",
      "ucn": "User Code Namespaces",
      "url-cloud-signup": "https://cloud.hazelcast.com/sign-up"
    },
    "5.4": {
      "ee-version": "5.4.5",
      "enterprise-product-name": "Enterprise Edition",
      "full-version": "5.4.5",
      "hazelcast-cloud": "Cloud",
      "minor-version": "5.4",
      "open-source-product-name": "Community Edition",
      "os-version": "5.4.0",
      "page-latest-supported-clc": "5.4.1",
      "page-latest-supported-cplusplus-client": "5.4.0",
      "page-latest-supported-csharp-client": "5.4.0",
      "page-latest-supported-go-client": "1.4.2",
      "page-latest-supported-java-client": "5.4.0",
      "page-latest-supported-mc": "5.4",
      "page-latest-supported-nodejs-client": "5.3.0",
      "page-latest-supported-python-client": "5.6.0",
      "ucd": "User Code Deployment",
      "ucn": "User Code Namespaces"
    },
    "5.3": {
      "ee-version": "5.3.8",
      "enterprise-product-name": "Enterprise Edition",
      "full-version": "5.3.8",
      "hazelcast-cloud": "Cloud",
      "java-client": "Java Client and Embedded Server",
      "minor-version": "5.3",
      "open-source-product-name": "Community Edition",
      "os-version": "5.3.0",
      "page-latest-supported-clc": "5.4.1",
      "page-latest-supported-cplusplus-client": "5.3.0",
      "page-latest-supported-csharp-client": "5.3.1",
      "page-latest-supported-go-client": "1.4.1",
      "page-latest-supported-java-client": "5.3.5",
      "page-latest-supported-mc": "5.3",
      "page-latest-supported-nodejs-client": "5.3.0",
      "page-latest-supported-python-client": "5.3.0",
      "ucd": "User Code Deployment",
      "ucn": "User Code Namespaces",
      "url-cloud-signup": "https://cloud.hazelcast.com/sign-up?utm_source=docs-website"
    },
    "5.2": {
      "full-version": "5.2.5",
      "hazelcast-cloud": "Cloud",
      "page-latest-supported-clc": "5.2.0-BETA-3",
      "page-latest-supported-cplusplus-client": "5.0.0",
      "page-latest-supported-csharp-client": "5.1.0",
      "page-latest-supported-go-client": "1.3.0",
      "page-latest-supported-java-client": "5.2.0",
      "page-latest-supported-mc": "5.2",
      "page-latest-supported-nodejs-client": "5.1.0",
      "page-latest-supported-python-client": "5.1",
      "ucd": "User Code Deployment",
      "ucn": "User Code Namespaces"
    },
    "5.1": {
      "full-version": "5.1.7",
      "hazelcast-cloud": "Cloud",
      "page-latest-supported-cplusplus-client": "5.0.0",
      "page-latest-supported-csharp-client": "5.0.0",
      "page-latest-supported-go-client": "1.1.1",
      "page-latest-supported-java-client": "5.1",
      "page-latest-supported-mc": "5.1",
      "page-latest-supported-nodejs-client": "5.0.4",
      "page-latest-supported-python-client": "5.0.1",
      "ucd": "User Code Deployment",
      "ucn": "User Code Namespaces"
    },
    "5.0": {
      "full-version": "5.0.5",
      "hazelcast-cloud": "Cloud",
      "page-latest-supported-cplusplus-client": "5.0.0",
      "page-latest-supported-csharp-client": "5.0.0",
      "page-latest-supported-go-client": "1.1.1",
      "page-latest-supported-java-client": "5.0.2",
      "page-latest-supported-mc": "5.0",
      "page-latest-supported-nodejs-client": "5.0.4",
      "page-latest-supported-python-client": "5.0.1",
      "ucd": "User Code Deployment",
      "ucn": "User Code Namespaces"
    }
  },
  "management-center": {
    "current": {
      "enterprise-product-name": "Enterprise Edition",
      "full-version": "5.12.0-SNAPSHOT",
      "mc-repo-swagger-branch": "master",
      "open-source-product-name": "Community Edition",
      "page-latest-supported-clc": "5.5.1",
      "page-latest-supported-hazelcast": "6.0-snapshot"
    },
    "5.11": {
      "enterprise-product-name": "Enterprise Edition",
      "full-version": "5.11.1",
      "mc-repo-swagger-branch": "5.11.1",
      "open-source-product-name": "Community Edition",
      "page-latest-supported-clc": "5.5.1",
      "page-latest-supported-hazelcast": "5.7"
    },
    "5.10": {
      "enterprise-product-name": "Enterprise Edition",
      "full-version": "5.10.0",
      "mc-repo-swagger-branch": "5.10.0",
      "open-source-product-name": "Community Edition",
      "page-latest-supported-clc": "5.5.1",
      "page-latest-supported-hazelcast": "5.6"
    },
    "5.9": {
      "enterprise-product-name": "Enterprise Edition",
      "full-version": "5.9.0",
      "mc-repo-swagger-branch": "5.9.0",
      "open-source-product-name": "Community Edition",
      "page-latest-supported-clc": "5.5.1",
      "page-latest-supported-hazelcast": "5.6"
    },
    "5.8": {
      "enterprise-product-name": "Enterprise Edition",
      "full-version": "5.8.0",
      "mc-repo-swagger-branch": "5.8.0",
      "open-source-product-name": "Community Edition",
      "page-latest-supported-clc": "5.4.1",
      "page-latest-supported-hazelcast": "5.5"
    },
    "5.7": {
      "enterprise-product-name": "Enterprise Edition",
      "full-version": "5.7.1",
      "mc-repo-swagger-branch": "5.7.0",
      "open-source-product-name": "Community Edition",
      "page-latest-supported-clc": "5.4.1",
      "page-latest-supported-hazelcast": "5.7"
    },
    "5.6": {
      "enterprise-product-name": "Enterprise Edition",
      "full-version": "5.6.0",
      "mc-repo-swagger-branch": "5.6.0",
      "open-source-product-name": "Community Edition",
      "page-latest-supported-clc": "5.4.1",
      "page-latest-supported-hazelcast": "5.5"
    },
    "5.5": {
      "enterprise-product-name": "Enterprise Edition",
      "full-version": "5.5.2",
      "mc-repo-swagger-branch": "5.5.2",
      "open-source-product-name": "Community Edition",
      "page-latest-supported-hazelcast": "5.5"
    },
    "5.4": {
      "enterprise-product-name": "Enterprise Edition",
      "full-version": "5.4.1",
      "mc-repo-swagger-branch": "5.4.1",
      "open-source-product-name": "Community Edition",
      "page-latest-supported-hazelcast": "5.4"
    },
    "5.3": {
      "enterprise-product-name": "Enterprise Edition",
      "full-version": "5.3.4",
      "mc-repo-swagger-branch": "5.3.4",
      "open-source-product-name": "Community Edition",
      "page-latest-supported-hazelcast": "5.3"
    },
    "5.2": {
      "enterprise-product-name": "Enterprise Edition",
      "full-version": "5.2.1",
      "mc-repo-swagger-branch": "5.2.1",
      "open-source-product-name": "Community Edition",
      "page-latest-supported-hazelcast": "5.2"
    },
    "5.1": {
      "enterprise-product-name": "Enterprise Edition",
      "full-version": "5.1.4",
      "mc-repo-swagger-branch": "5.1.4",
      "open-source-product-name": "Community Edition",
      "page-latest-supported-hazelcast": "5.1"
    },
    "5.0": {
      "enterprise-product-name": "Enterprise Edition",
      "full-version": "5.0.4",
      "open-source-product-name": "Community Edition",
      "page-latest-supported-hazelcast": "5.0"
    },
    "4.2021.06": {
      "page-latest-supported-hazelcast": ""
    },
    "4.2021.04": {
      "page-latest-supported-hazelcast": ""
    },
    "4.2021.03": {
      "page-latest-supported-hazelcast": ""
    },
    "4.2021.02": {
      "page-latest-supported-hazelcast": ""
    },
    "4.2020.12": {
      "page-latest-supported-hazelcast": ""
    }
  },
  "operator": {
    "current": {
      "operator-chart-version": "5.20.0-snapshot",
      "page-latest-supported-hazelcast": "5.7.1",
      "page-latest-supported-mc": "5.11.1"
    },
    "5.19": {
      "operator-chart-version": "5.19.0",
      "page-latest-supported-hazelcast": "5.7.1",
      "page-latest-supported-mc": "5.11.1"
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
