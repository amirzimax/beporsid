<?php
/**
 * Plugin Name:       چت‌بات هوش مصنوعی بپرسید
 * Plugin URI:        https://beporsid.com/
 * Description:       دستیار هوش مصنوعی فروش که به محصولات، قیمت و موجودی واقعی ووکامرس وصل می‌شود و ۲۴ ساعته به مشتری‌ها جواب می‌دهد. اتصال با یک کد؛ بدون ساخت کلید API و بدون ویرایش قالب.
 * Version:           1.0.0
 * Requires at least: 5.8
 * Requires PHP:      7.4
 * Author:            بپرسید
 * Author URI:        https://beporsid.com/
 * License:           GPLv2 or later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       beporsid-chatbot
 */

// روند کار:
//   ۱. صاحب فروشگاه در پنل بپرسید یک «کد اتصال» می‌سازد و این‌جا وارد می‌کند.
//   ۲. اگر ووکامرس فعال باشد، افزونه یک کلید REST «فقط خواندنی» می‌سازد (همان کاری که خود
//      ووکامرس در بخش REST API انجام می‌دهد) و همراه کد اتصال به سرور بپرسید می‌فرستد.
//   ۳. ویجت چت خودکار در فوتر سایت قرار می‌گیرد؛ رنگ و جای آن از پنل بپرسید خوانده می‌شود.
// با قطع اتصال یا حذف افزونه، کلید ووکامرسی که ساخته شده بود پاک می‌شود.

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'BEPORSID_VERSION', '1.0.0' );
// قابل تغییر در wp-config.php (برای محیط آزمایشی)
if ( ! defined( 'BEPORSID_API' ) ) {
	define( 'BEPORSID_API', 'https://api.beporsid.com' );
}
if ( ! defined( 'BEPORSID_DASHBOARD' ) ) {
	define( 'BEPORSID_DASHBOARD', 'https://api.beporsid.com/dashboard.html' );
}

final class Beporsid_Chatbot {

	const OPT           = 'beporsid_chatbot';
	const CFG_TRANSIENT = 'beporsid_widget_cfg';
	const NOTICE        = 'beporsid_notice';
	const TOKEN_RE      = '/^bpwp_[a-f0-9]{40}$/';

	public static function init() {
		add_action( 'admin_menu', array( __CLASS__, 'menu' ) );
		add_action( 'admin_post_beporsid_connect', array( __CLASS__, 'handle_connect' ) );
		add_action( 'admin_post_beporsid_disconnect', array( __CLASS__, 'handle_disconnect' ) );
		add_action( 'admin_notices', array( __CLASS__, 'setup_notice' ) );
		add_action( 'wp_footer', array( __CLASS__, 'render_widget' ), 99 );
		add_filter( 'plugin_action_links_' . plugin_basename( __FILE__ ), array( __CLASS__, 'action_links' ) );
	}

	/* ---------- تنظیمات ذخیره‌شده ---------- */

	public static function opts() {
		$o = get_option( self::OPT, array() );
		return is_array( $o ) ? $o : array();
	}

	private static function save( $o ) {
		update_option( self::OPT, $o, false );
	}

	private static function connected() {
		$o = self::opts();
		return ! empty( $o['token'] ) && ! empty( $o['site_key'] );
	}

	/* ---------- ارتباط با سرور بپرسید ---------- */

	// خروجی: array( کد HTTP, آرایه‌ی پاسخ ) یا WP_Error
	private static function api( $path, $body ) {
		$res = wp_remote_post(
			BEPORSID_API . $path,
			array(
				'timeout' => 25,
				'headers' => array( 'Content-Type' => 'application/json' ),
				'body'    => wp_json_encode( $body ),
			)
		);
		if ( is_wp_error( $res ) ) {
			return $res;
		}
		$data = json_decode( wp_remote_retrieve_body( $res ), true );
		return array( (int) wp_remote_retrieve_response_code( $res ), is_array( $data ) ? $data : array() );
	}

	/* ---------- کلید فقط‌خواندنی ووکامرس ---------- */

	// همان روشی که ووکامرس در WC_Auth::create_keys برای ساخت کلید استفاده می‌کند.
	// سطح دسترسی «read» است: سرور بپرسید فقط محصولات و وضعیت سفارش را می‌خواند و هیچ چیزی را تغییر نمی‌دهد.
	private static function create_woo_key() {
		if ( ! class_exists( 'WooCommerce' ) || ! function_exists( 'wc_rand_hash' ) || ! function_exists( 'wc_api_hash' ) ) {
			return null;
		}
		global $wpdb;
		$consumer_key    = 'ck_' . wc_rand_hash();
		$consumer_secret = 'cs_' . wc_rand_hash();
		$ok = $wpdb->insert(
			$wpdb->prefix . 'woocommerce_api_keys',
			array(
				'user_id'         => get_current_user_id(),
				'description'     => 'Beporsid chatbot (read-only)',
				'permissions'     => 'read',
				'consumer_key'    => wc_api_hash( $consumer_key ),
				'consumer_secret' => $consumer_secret,
				'truncated_key'   => substr( $consumer_key, -7 ),
			),
			array( '%d', '%s', '%s', '%s', '%s', '%s' )
		);
		if ( ! $ok ) {
			return null;
		}
		return array(
			'id' => (int) $wpdb->insert_id,
			'ck' => $consumer_key,
			'cs' => $consumer_secret,
		);
	}

	public static function delete_woo_key( $key_id ) {
		if ( ! $key_id ) {
			return;
		}
		global $wpdb;
		$wpdb->delete( $wpdb->prefix . 'woocommerce_api_keys', array( 'key_id' => (int) $key_id ), array( '%d' ) );
	}

	/* ---------- پیام‌های بعد از ریدایرکت ---------- */

	private static function notice( $type, $text ) {
		set_transient( self::NOTICE . '_' . get_current_user_id(), array( 'type' => $type, 'text' => $text ), 120 );
	}

	private static function back() {
		wp_safe_redirect( admin_url( 'admin.php?page=beporsid' ) );
		exit;
	}

	/* ---------- اتصال ---------- */

	public static function handle_connect() {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( 'دسترسی ندارید.' );
		}
		check_admin_referer( 'beporsid_connect' );

		$token = isset( $_POST['token'] ) ? trim( sanitize_text_field( wp_unslash( $_POST['token'] ) ) ) : '';
		if ( ! preg_match( self::TOKEN_RE, $token ) ) {
			self::notice( 'error', 'کد اتصال درست نیست. کد را دقیقاً از پنل بپرسید کپی کنید؛ با bpwp_ شروع می‌شود.' );
			self::back();
		}

		// اگر قبلاً وصل بوده، کلید قدیمی پاک می‌شود تا کلید اضافه در ووکامرس نماند
		$old = self::opts();
		if ( ! empty( $old['woo_key_id'] ) ) {
			self::delete_woo_key( $old['woo_key_id'] );
		}

		$key  = self::create_woo_key();
		$body = array(
			'token'          => $token,
			'site_url'       => home_url(),
			'plugin_version' => BEPORSID_VERSION,
			'wp_version'     => get_bloginfo( 'version' ),
		);
		if ( $key ) {
			$body['consumer_key']    = $key['ck'];
			$body['consumer_secret'] = $key['cs'];
		}

		$r = self::api( '/api/wp-plugin/connect', $body );
		if ( is_wp_error( $r ) || 200 !== $r[0] ) {
			if ( $key ) {
				self::delete_woo_key( $key['id'] );
			}
			$msg = is_wp_error( $r )
				? 'ارتباط با سرور بپرسید برقرار نشد. ممکن است میزبان سایت درخواست‌های بیرونی را بسته باشد. (' . $r->get_error_message() . ')'
				: ( ! empty( $r[1]['error'] ) ? $r[1]['error'] : 'اتصال ناموفق بود. دوباره تلاش کنید.' );
			self::notice( 'error', $msg );
			self::back();
		}

		$data = $r[1];
		// اگر سرور نتوانست محصولات را با این کلید بخواند، کلید بی‌استفاده را نگه نمی‌داریم
		if ( $key && empty( $data['woo_connected'] ) ) {
			self::delete_woo_key( $key['id'] );
			$key = null;
		}

		self::save(
			array(
				'token'         => $token,
				'site_key'      => sanitize_text_field( $data['site_key'] ),
				'shop_name'     => sanitize_text_field( isset( $data['shop_name'] ) ? $data['shop_name'] : '' ),
				'woo_key_id'    => $key ? $key['id'] : 0,
				'woo_connected' => ! empty( $data['woo_connected'] ),
				'connected_at'  => time(),
			)
		);
		delete_transient( self::CFG_TRANSIENT );

		$text = 'بپرسید وصل شد و ویجت چت روی سایت فعال است.';
		if ( ! empty( $data['woo_connected'] ) ) {
			$text .= ' محصولات، قیمت و موجودی ووکامرس هم به دستیار وصل شد.';
		}
		$type = 'success';
		if ( ! empty( $data['woo_error'] ) ) {
			$text .= ' ' . $data['woo_error'];
			$type  = 'warning';
		}
		if ( ! empty( $data['warning'] ) ) {
			$text .= ' ' . $data['warning'];
			$type  = 'warning';
		}
		self::notice( $type, $text );
		self::back();
	}

	public static function handle_disconnect() {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( 'دسترسی ندارید.' );
		}
		check_admin_referer( 'beporsid_disconnect' );
		self::disconnect_everything();
		self::notice( 'success', 'اتصال بپرسید قطع شد، ویجت از سایت برداشته شد و کلید ووکامرسی که ساخته بودیم پاک شد.' );
		self::back();
	}

	// در قطع اتصال و حذف افزونه هر دو استفاده می‌شود
	public static function disconnect_everything() {
		$o = self::opts();
		if ( ! empty( $o['token'] ) ) {
			self::api( '/api/wp-plugin/disconnect', array( 'token' => $o['token'] ) );
		}
		if ( ! empty( $o['woo_key_id'] ) ) {
			self::delete_woo_key( $o['woo_key_id'] );
		}
		delete_option( self::OPT );
		delete_transient( self::CFG_TRANSIENT );
	}

	/* ---------- ویجت در سایت ---------- */

	// رنگ و جای ویجت از پنل بپرسید خوانده و ۱۲ ساعت نگه داشته می‌شود؛ اگر سرور در دسترس
	// نبود، ویجت با تنظیمات پیش‌فرض بالا می‌آید و نیم ساعت بعد دوباره تلاش می‌شود.
	private static function widget_config( $site_key ) {
		$cfg = get_transient( self::CFG_TRANSIENT );
		if ( is_array( $cfg ) ) {
			return $cfg;
		}
		$cfg = array();
		$res = wp_remote_get( BEPORSID_API . '/api/chat/config?siteKey=' . rawurlencode( $site_key ), array( 'timeout' => 4 ) );
		if ( ! is_wp_error( $res ) && 200 === (int) wp_remote_retrieve_response_code( $res ) ) {
			$data = json_decode( wp_remote_retrieve_body( $res ), true );
			if ( is_array( $data ) ) {
				if ( ! empty( $data['color'] ) && preg_match( '/^#[0-9a-fA-F]{6}$/', $data['color'] ) ) {
					$cfg['color'] = $data['color'];
				}
				if ( isset( $data['side'] ) && in_array( $data['side'], array( 'left', 'right' ), true ) ) {
					$cfg['side'] = $data['side'];
				}
				foreach ( array( 'desktopBottom', 'desktopSideOffset', 'mobileBottom', 'mobileSideOffset' ) as $k ) {
					if ( isset( $data[ $k ] ) && is_numeric( $data[ $k ] ) ) {
						$cfg[ $k ] = (int) $data[ $k ];
					}
				}
			}
			set_transient( self::CFG_TRANSIENT, $cfg, 12 * HOUR_IN_SECONDS );
		} else {
			set_transient( self::CFG_TRANSIENT, $cfg, 30 * MINUTE_IN_SECONDS );
		}
		return $cfg;
	}

	public static function render_widget() {
		if ( is_admin() ) {
			return;
		}
		$o = self::opts();
		if ( empty( $o['site_key'] ) ) {
			return;
		}
		$config = array_merge(
			array(
				'apiUrl'  => BEPORSID_API . '/api/chat',
				'siteKey' => $o['site_key'],
			),
			self::widget_config( $o['site_key'] )
		);
		$src = BEPORSID_API . '/widget.js?v=' . substr( $o['site_key'], -4 );
		echo "\n<!-- Beporsid AI chatbot -->\n";
		echo '<script>window.ChatbotWidgetConfig = ' . wp_json_encode( $config ) . ";</script>\n";
		echo '<script src="' . esc_url( $src ) . '"></script>' . "\n";
	}

	/* ---------- پیشخوان وردپرس ---------- */

	public static function menu() {
		add_menu_page( 'چت‌بات بپرسید', 'بپرسید', 'manage_options', 'beporsid', array( __CLASS__, 'page' ), 'dashicons-format-chat', 58 );
	}

	public static function action_links( $links ) {
		array_unshift( $links, '<a href="' . esc_url( admin_url( 'admin.php?page=beporsid' ) ) . '">تنظیمات</a>' );
		return $links;
	}

	// یادآوری اتصال فقط در صفحه‌ی افزونه‌ها، تا مزاحم بقیه‌ی پیشخوان نشود
	public static function setup_notice() {
		$screen = function_exists( 'get_current_screen' ) ? get_current_screen() : null;
		if ( ! $screen || 'plugins' !== $screen->id || ! current_user_can( 'manage_options' ) || self::connected() ) {
			return;
		}
		echo '<div class="notice notice-info"><p><strong>چت‌بات بپرسید</strong> نصب شد. برای فعال شدن، <a href="' . esc_url( admin_url( 'admin.php?page=beporsid' ) ) . '">کد اتصال را وارد کنید</a>.</p></div>';
	}

	public static function page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$notice = get_transient( self::NOTICE . '_' . get_current_user_id() );
		delete_transient( self::NOTICE . '_' . get_current_user_id() );
		$o = self::opts();
		?>
		<div class="wrap beporsid-wrap">
			<style>
				.beporsid-wrap .bp-card { background: #fff; border: 1px solid #dcdcde; border-radius: 12px; padding: 22px 26px; max-width: 760px; margin-top: 18px; }
				.beporsid-wrap h1 { display: flex; align-items: center; gap: 10px; }
				.beporsid-wrap .bp-mark { width: 34px; height: 34px; border-radius: 10px; background: #12807a; display: inline-grid; place-items: center; }
				.beporsid-wrap .bp-mark svg { width: 18px; height: 18px; fill: #fff; }
				.beporsid-wrap ol li { margin-bottom: 10px; line-height: 1.9; }
				.beporsid-wrap .bp-token { width: 100%; max-width: 480px; direction: ltr; font-family: monospace; }
				.beporsid-wrap .bp-status { display: grid; grid-template-columns: 170px 1fr; gap: 8px 16px; margin: 6px 0 18px; }
				.beporsid-wrap .bp-status b { color: #50575e; font-weight: 600; }
				.beporsid-wrap .bp-ok { color: #12807a; font-weight: 700; }
				.beporsid-wrap .bp-warn { color: #996800; font-weight: 700; }
				.beporsid-wrap .button-primary { background: #12807a; border-color: #12807a; }
				.beporsid-wrap .button-primary:hover { background: #0b5b57; border-color: #0b5b57; }
			</style>
			<h1><span class="bp-mark"><svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.03 2 11c0 2.44 1.15 4.65 3 6.3V22l4.1-2.05c.93.2 1.9.3 2.9.3 5.52 0 10-4.03 10-9S17.52 2 12 2z"/></svg></span>چت‌بات هوش مصنوعی بپرسید</h1>

			<?php if ( $notice ) : ?>
				<div class="notice notice-<?php echo esc_attr( $notice['type'] ); ?>"><p><?php echo esc_html( $notice['text'] ); ?></p></div>
			<?php endif; ?>

			<?php if ( self::connected() ) : ?>
				<?php
				$st = self::api( '/api/wp-plugin/status', array( 'token' => $o['token'] ) );
				$st = ( ! is_wp_error( $st ) && 200 === $st[0] ) ? $st[1] : null;
				$platforms = array( 'woocommerce' => 'ووکامرس (همین سایت)', 'shopfa' => 'شاپفا', 'portal' => 'پرتال', 'manual' => 'محصولات واردشده در پنل' );
				?>
				<div class="bp-card">
					<h2 style="margin-top:0">وضعیت</h2>
					<div class="bp-status">
						<b>فروشگاه در بپرسید</b><span><?php echo esc_html( $st && $st['shop_name'] ? $st['shop_name'] : ( $o['shop_name'] ? $o['shop_name'] : '—' ) ); ?></span>
						<b>ویجت روی سایت</b><span class="bp-ok">فعال</span>
						<b>محصولات</b>
						<?php if ( $st && ! empty( $st['platform'] ) ) : ?>
							<span class="bp-ok">از <?php echo esc_html( isset( $platforms[ $st['platform'] ] ) ? $platforms[ $st['platform'] ] : $st['platform'] ); ?></span>
						<?php elseif ( class_exists( 'WooCommerce' ) ) : ?>
							<span class="bp-warn">وصل نیست؛ دستیار فقط از پایگاه دانش جواب می‌دهد</span>
						<?php else : ?>
							<span>ووکامرس نصب نیست؛ دستیار از پایگاه دانش جواب می‌دهد</span>
						<?php endif; ?>
						<b>پلن</b><span><?php echo esc_html( $st ? $st['plan'] : '—' ); ?></span>
					</div>
					<?php if ( ! $st ) : ?>
						<p class="bp-warn">وضعیت از سرور بپرسید دریافت نشد؛ ویجت با آخرین تنظیمات کار می‌کند.</p>
					<?php endif; ?>
					<p>
						<a class="button button-primary" href="<?php echo esc_url( BEPORSID_DASHBOARD ); ?>" target="_blank" rel="noopener">باز کردن پنل بپرسید</a>
						&nbsp;
						<a class="button" href="<?php echo esc_url( home_url( '/' ) ); ?>" target="_blank" rel="noopener">دیدن ویجت روی سایت</a>
					</p>
					<p class="description">گفتگوها، پایگاه دانش، رنگ و جای ویجت را از پنل بپرسید تنظیم کنید؛ تغییرات حداکثر تا ۱۲ ساعت بعد این‌جا هم اعمال می‌شود. اگر قبلاً کد نصب را دستی در قالب گذاشته بودید، آن را پاک کنید تا ویجت دو بار نیاید.</p>
					<hr>
					<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" onsubmit="return confirm('اتصال قطع شود؟ ویجت از سایت برداشته می‌شود.');">
						<?php wp_nonce_field( 'beporsid_disconnect' ); ?>
						<input type="hidden" name="action" value="beporsid_disconnect">
						<button type="submit" class="button button-link-delete">قطع اتصال</button>
					</form>
				</div>
			<?php else : ?>
				<div class="bp-card">
					<p style="font-size:14px;margin-top:0">دستیار هوش مصنوعی فروش که به محصولات، قیمت و موجودی واقعی فروشگاه شما وصل می‌شود و ۲۴ ساعته به مشتری‌ها جواب می‌دهد. نیازی به ساخت کلید API یا ویرایش قالب نیست.</p>
					<ol>
						<li>در <a href="<?php echo esc_url( BEPORSID_DASHBOARD ); ?>" target="_blank" rel="noopener">پنل بپرسید</a> ثبت‌نام کنید (رایگان، ۲۰۰ پاسخ در ماه).</li>
						<li>در پنل به <strong>تنظیمات ← اتصال فروشگاه ← ووکامرس</strong> بروید و روی <strong>«ساخت کد اتصال افزونه»</strong> بزنید.</li>
						<li>کد را این‌جا وارد کنید و «اتصال» را بزنید.</li>
					</ol>
					<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
						<?php wp_nonce_field( 'beporsid_connect' ); ?>
						<input type="hidden" name="action" value="beporsid_connect">
						<p><input type="text" name="token" class="regular-text bp-token" placeholder="bpwp_..." autocomplete="off" required></p>
						<p><button type="submit" class="button button-primary button-hero">اتصال به بپرسید</button></p>
					</form>
					<?php if ( class_exists( 'WooCommerce' ) ) : ?>
						<p class="description">برای خواندن محصولات، افزونه یک کلید «فقط خواندنی» در ووکامرس (ووکامرس ← تنظیمات ← پیشرفته ← REST API) با نام Beporsid chatbot می‌سازد. بپرسید با آن هیچ چیزی را در فروشگاه تغییر نمی‌دهد و با قطع اتصال، کلید پاک می‌شود.</p>
					<?php else : ?>
						<p class="description">ووکامرس روی این سایت فعال نیست؛ ویجت نصب می‌شود و دستیار از پایگاه دانشی که در پنل می‌سازید جواب می‌دهد.</p>
					<?php endif; ?>
				</div>
			<?php endif; ?>
		</div>
		<?php
	}
}

Beporsid_Chatbot::init();
