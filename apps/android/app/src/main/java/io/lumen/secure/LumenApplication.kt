package io.lumen.secure

import android.app.Application
import android.content.Context

class LumenApplication : Application() {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        graph = AppGraph(this)
        graph.init()
    }

    companion object {
        fun graph(context: Context): AppGraph = (context.applicationContext as LumenApplication).graph
    }
}
