<?php
// حذف کامل افزونه: اتصال در سرور بپرسید قطع و کلید فقط‌خواندنی ووکامرس پاک می‌شود.
if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

require_once __DIR__ . '/beporsid-chatbot.php';
Beporsid_Chatbot::disconnect_everything();
delete_transient( 'beporsid_notice_' . get_current_user_id() );
