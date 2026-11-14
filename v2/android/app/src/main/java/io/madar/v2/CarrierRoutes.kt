package io.madar.v2

import android.content.Context

/**
 * These are labelled carrier preferences, not a claim that a route is
 * universally reachable on a cellular network. Only server-verified routes
 * for the explicitly chosen operator may be used.
 */
enum class CarrierOperator(val code: String) {
    MCI("mci"),
    IRANCELL("irancell");

    companion object {
        fun fromCode(raw: String?): CarrierOperator? = entries.firstOrNull { it.code == raw }
    }
}

object CarrierRoutes {
    fun select(snapshot: SubscriptionSnapshot, carrier: CarrierOperator): List<VerifiedRoute> =
        snapshot.routes.filter {
            it.transport == "reality" && it.operatorHint == carrier.code
        }
}

/** Non-secret preference only; no access token stored here. */
class CarrierSelectionStore(context: Context) {
    private val preferences = context.applicationContext
        .getSharedPreferences("madar_v2_settings", Context.MODE_PRIVATE)

    fun read(): CarrierOperator? =
        CarrierOperator.fromCode(preferences.getString("selected_carrier", null))

    fun save(carrier: CarrierOperator): Boolean =
        preferences.edit().putString("selected_carrier", carrier.code).commit()
}
