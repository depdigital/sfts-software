# Fresh Router Setup for SFTS

This guide configures a fresh TP-Link TL-WR820N as a private Wi-Fi network for the SFTS ESP32 remotes.

The final network layout is:

```text
Personal Wi-Fi  → Raspberry Pi built-in Wi-Fi (wlan0)
                  Internet and SSH access

SFTS-REMOTE     → TP-Link router → Raspberry Pi Ethernet (eth0)
192.168.50.x                      Local remote-button network
```

The TP-Link router does not need an internet connection.

## 1. Prepare the router

1. Unbox and power on the TL-WR820N.
2. Do not connect anything to the blue WAN/Internet port.
3. Connect a laptop or phone to the default Wi-Fi printed on the router label, or connect the laptop to a yellow LAN port.
4. Open `http://tplinkwifi.net`.
5. If that address does not open, use `http://192.168.0.1`.
6. Create and save the router administrator password.

Check the hardware version printed on the router label before installing firmware. Never install firmware for a different hardware version.

## 2. Configure Internet/WAN settings

The WAN port is not used in this deployment.

In the Internet setup section:

```text
Connection type: Dynamic IP
IP address:     Automatic
Subnet mask:    Automatic
Gateway:        Automatic
DNS:            Automatic
Secondary DNS:  Automatic
MTU:            Default, normally 1500
```

If the wizard reports that no internet cable is connected, continue or skip the internet check. This is expected because the router is only providing the local remote network.

Do not enter invented static Internet values. Static WAN values are supplied by an ISP and are not required for this setup.

## 3. Configure the remote Wi-Fi

Set the wireless network to a dedicated name and password:

```text
SSID:     SFTS-REMOTE
Password: <choose a strong event-only password>
Security: WPA2-PSK / AES
```

Keep SSID broadcast enabled. The TL-WR820N provides a 2.4 GHz network, which is required by the ESP32 remotes.

Do not use a guest network. If the router exposes an AP/client isolation option, disable it so devices on `SFTS-REMOTE` can reach the Pi.

## 4. Configure the router LAN

First check the subnet used by the personal Wi-Fi. It must not also use `192.168.50.x`.

If the personal Wi-Fi uses a different subnet, go to:

```text
Advanced → Network → LAN
```

Set:

```text
LAN IP address:  192.168.50.1
Subnet mask:     255.255.255.0
```

If the personal Wi-Fi already uses `192.168.50.x`, use `192.168.60.1` instead and replace `192.168.50.x` with `192.168.60.x` throughout this guide.

After saving, reconnect to the router and open its new address:

```text
http://192.168.50.1
```

## 5. Enable DHCP

Go to:

```text
Advanced → Network → DHCP Server
```

Use:

```text
DHCP server: Enabled
Start IP:    192.168.50.100
End IP:      192.168.50.200
Lease time:  Default or 120 minutes
Gateway:     192.168.50.1
DNS:         192.168.50.1 or Automatic
```

Save the settings.

## 6. Connect and verify a phone

Connect a phone to `SFTS-REMOTE` and check its network details.

Expected values:

```text
Phone IP:  192.168.50.xxx
Router:    192.168.50.1
```

For example, an address such as `192.168.50.101` is correct. Open the following address in the phone browser to confirm router access:

```text
http://192.168.50.1
```

## 7. Connect the Raspberry Pi

Keep the Pi connected to the personal Wi-Fi for SSH and internet access.

Connect:

```text
TP-Link yellow LAN port ↔ Raspberry Pi Ethernet port
```

Do not use the blue WAN/Internet port.

On the Pi, run:

```bash
nmcli device status
ip -4 addr show eth0
ip route
```

Expected results:

```text
wlan0: personal Wi-Fi, for example 192.168.0.102
eth0:  SFTS-REMOTE network, for example 192.168.50.102
```

The Pi should be able to reach the router:

```bash
ping -c 3 192.168.50.1
```

## 8. Keep internet traffic on Pi Wi-Fi

The Pi must use `wlan0` for internet traffic. The Ethernet interface should only be used for local SFTS remote traffic.

Run on the Pi:

```bash
sudo nmcli connection modify netplan-eth0 ipv4.never-default yes ipv6.never-default yes
sudo nmcli connection down netplan-eth0
sudo nmcli connection up netplan-eth0
```

Verify:

```bash
ip route
```

The expected route pattern is:

```text
default via 192.168.0.1 dev wlan0
192.168.50.0/24 dev eth0
```

The default route must not use `eth0` or `192.168.50.1`.

Test both paths:

```bash
ping -c 3 192.168.50.1
ping -c 3 google.com
```

## 9. Bind the Pi Ethernet address

The Pi should keep a predictable Ethernet address for the remotes.

On the router, open:

```text
Advanced → Security → IP & MAC Binding
```

1. Open the ARP list.
2. Click **Refresh**.
3. Find the Pi at `192.168.50.102`.
4. Confirm the Ethernet MAC address matches the Pi:

   ```bash
   ip link show eth0
   ```

5. Enable **Bind** for the Pi entry and save.

If the router firmware provides a separate DHCP reservation option, reserve the same address there. If it does not, the binding above is sufficient for this setup; the Pi can also be assigned a fixed Ethernet address later if required.

## 10. Final network checklist

Before deploying the SFTS software, confirm:

- The phone receives a `192.168.50.x` address.
- The Pi Ethernet interface receives `192.168.50.102` or the reserved address.
- The Pi can ping `192.168.50.1`.
- The Pi can ping `google.com` through `wlan0`.
- `ip route` shows the default route through `wlan0`.
- The Pi Ethernet cable is connected to a yellow LAN port.
- The router WAN/Internet port is unused.
- AP/client isolation is disabled if the router exposes that option.

The SFTS application can then be installed on the Pi and configured to listen on its Ethernet address for the remotes.

## Official references

- [TL-WR820N support and downloads](https://www.tp-link.com/in/support/download/tl-wr820n/)
- [TL-WR820N user guide](https://static.tp-link.com/2018/201810/20181030/1910012464_TL-WR820N%28EU%29_UG_REV1.0.0.pdf)
- [TL-WR820N IP & MAC Binding instructions](https://www.tp-link.com/ae/support/faq/2348/)
