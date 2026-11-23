import com.hazelcast.client.config.ClientConfig;
import com.hazelcast.config.Config;

public class MetricsConfiguration {

    public static void main(String[] args) {
        //tag::member[]
        Config config = new Config();
        config.getMetricsConfig()
              .setEnabled(true)
              .setCollectionFrequencySeconds(5);
        config.getMetricsConfig().getManagementCenterConfig()
              .setEnabled(true)
              .setRetentionSeconds(5);
        config.getMetricsConfig().getJmxConfig()
              .setEnabled(true);
        //end::member[]

        //tag::client[]
        ClientConfig clientConfig = new ClientConfig();
        clientConfig.getMetricsConfig()
                    .setEnabled(true)
                    .setCollectionFrequencySeconds(5);
        clientConfig.getMetricsConfig().getJmxConfig()
                    .setEnabled(true);
        //end::client[]
    }
}
