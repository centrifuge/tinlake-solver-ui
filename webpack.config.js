/** @type {import('@types/webpack').Configuration} */

const CopyWebpackPlugin = require("copy-webpack-plugin");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const webpack = require("webpack");

module.exports = {
  entry: "./app.js",
  mode: "development",
  output: {
    path: `${__dirname}/dist`,
    filename: "bundle.js",
  },
  devServer: {
    contentBase: "./dist",
    open: true,
  },
  module: {
    rules: [
      {
        test: /\.css$/,
        use: ["style-loader", "css-loader"],
      },
      {
        test: /\.(jpe?g|png|gif)$/i,
        loader:"file-loader",
        options:{
          name:'[name].[ext]',
          outputPath:'assets/images/'
          //the images will be emited to dist/assets/images/ folder
        }
      }
    ],
    
  },
  target: "web",
  plugins: [
    new HtmlWebpackPlugin({
      template: "./index.html",
      inject: true,
      filename: "index.html",
    }),
    new CopyWebpackPlugin({
      patterns: [
        {
          from: "assets/",
          to: "./",
        },
      ],
    }),
    new webpack.ProvidePlugin({
      $: "jquery",
      jQuery: "jquery",
      "window.jQuery": "jquery'",
      "window.$": "jquery",
    }),
  ],
  resolve: {
    fallback: {
      fs: false,
      path: false,
      crypto: false,
    },
  },
};
